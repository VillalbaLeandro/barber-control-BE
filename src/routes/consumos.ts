import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import sql from '../db-admin.js'
import { getEmpresaIdFromRequest, obtenerEmpresaIdPorPuntoVenta } from '../utils/empresa.js'
import { logAuditEvent } from '../utils/audit.js'
import { procesarOperativaCajaEnMovimiento } from '../utils/operativa-runtime.js'
import { authService } from '../services/auth.js'

// Schemas de validación
const registrarConsumoSchema = z.object({
    staffId: z.string().uuid(),
    puntoVentaId: z.string().uuid(),
    accionCajaCerrada: z.enum(['abrir', 'fuera_caja']).optional(),
    items: z.array(z.object({
        tipo: z.enum(['servicio', 'producto']),
        itemId: z.string().uuid(),
        nombre: z.string(),
        cantidad: z.number().positive(),
        precioVenta: z.number().positive(),
        precioCosto: z.number().nonnegative(), // Permitir 0 para servicios
        subtotalVenta: z.number().positive(),
        subtotalCosto: z.number().nonnegative() // Permitir 0 para servicios
    })).min(1)
})

const liquidarConsumosSchema = z.object({
    consumoIds: z.array(z.string().uuid()).min(1),
    reglaAplicada: z.enum(['precio_venta', 'precio_costo', 'porcentaje', 'monto_fijo', 'perdonado']),
    valorRegla: z.number().optional(), // Porcentaje (0-100) o monto fijo
    motivo: z.string().optional(),
    medioPago: z.enum(['efectivo', 'tarjeta', 'transferencia']).optional(),
})

const cancelarRapidoConsumoSchema = z.object({
    staffId: z.string().uuid(),
    puntoVentaId: z.string().uuid(),
})

const consumosRoutes: FastifyPluginAsync = async (fastify, opts) => {
    // Registrar consumo del staff
    fastify.post('/consumos/registrar', async (request, reply) => {
        try {
            console.log('📦 Registrando consumo, body:', JSON.stringify(request.body, null, 2));
            const { staffId, puntoVentaId, accionCajaCerrada, items } = registrarConsumoSchema.parse(request.body)

            const resultadoCaja = await procesarOperativaCajaEnMovimiento({
                puntoVentaId,
                usuarioId: staffId,
                request,
                motivo: 'registro_consumo_staff',
                tipoOperacion: 'consumo',
                accionCajaCerrada,
            })

            if (resultadoCaja.requiereDecisionCajaCerrada) {
                return reply.code(409).send({
                    error: 'CAJA_CERRADA_REQUIERE_DECISION',
                    mensaje: resultadoCaja.mensajeDecision,
                    puedeAbrirCaja: resultadoCaja.puedeAbrirCaja,
                    permitirFueraCaja: resultadoCaja.permitirFueraCaja,
                    accionSugerida: resultadoCaja.accionSugerida,
                })
            }

            // Calcular totales
            const totalVenta = items.reduce((sum, item) => sum + item.subtotalVenta, 0)
            const totalCosto = items.reduce((sum, item) => sum + item.subtotalCosto, 0)

            // Crear consumo
            const consumo = await sql`
                INSERT INTO consumos_staff (
                    usuario_id, 
                    punto_venta_id, 
                    items, 
                    total_venta, 
                    total_costo,
                    estado_liquidacion,
                    creado_en
                )
                VALUES (
                    ${staffId}, 
                    ${puntoVentaId}, 
                    ${JSON.stringify(items)}::jsonb, 
                    ${totalVenta}, 
                    ${totalCosto},
                    'pendiente',
                    NOW()
                )
                RETURNING id, usuario_id, punto_venta_id, items, total_venta, total_costo, estado_liquidacion, creado_en
            `

            return {
                consumoId: consumo[0].id,
                staffId: consumo[0].usuario_id,
                puntoVentaId: consumo[0].punto_venta_id,
                items: consumo[0].items,
                totalVenta: consumo[0].total_venta,
                totalCosto: consumo[0].total_costo,
                estadoLiquidacion: consumo[0].estado_liquidacion,
                creadoEn: consumo[0].creado_en
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                console.error('❌ Validation Error en consumos:', err.errors);
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    // Listar consumos (con filtros múltiples)
    fastify.get('/consumos', async (request, reply) => {
        try {
            const { staffId, puntoVentaId, fechaDesde, fechaHasta, estado, limit = 50, offset = 0 } = request.query as {
                staffId?: string
                puntoVentaId?: string
                fechaDesde?: string
                fechaHasta?: string
                estado?: string
                limit?: number
                offset?: number
            }

            let query = sql`
                SELECT 
                    c.id,
                    c.usuario_id,
                    s.nombre_completo as staff_nombre,
                    c.punto_venta_id,
                    pv.nombre as punto_venta_nombre,
                    c.items,
                    c.total_venta,
                    c.total_costo,
                    c.estado_liquidacion,
                    c.creado_en,
                    c.liquidado_en,
                    l.regla_aplicada,
                    l.monto_cobrado,
                    l.motivo
                FROM consumos_staff c
                JOIN usuarios s ON c.usuario_id = s.id
                JOIN puntos_venta pv ON c.punto_venta_id = pv.id
                LEFT JOIN liquidaciones_consumo l ON c.id = l.consumo_id
                WHERE 1=1
            `

            // Filtros opcionales
            if (staffId) {
                query = sql`${query} AND c.usuario_id = ${staffId}`
            }
            if (puntoVentaId) {
                query = sql`${query} AND c.punto_venta_id = ${puntoVentaId}`
            }
            if (fechaDesde) {
                query = sql`${query} AND c.creado_en >= ${fechaDesde}::timestamp`
            }
            if (fechaHasta) {
                query = sql`${query} AND c.creado_en <= ${fechaHasta}::timestamp`
            }
            if (estado) {
                if (estado === 'historial') {
                    // Historial = todo lo que NO es pendiente
                    query = sql`${query} AND c.estado_liquidacion != 'pendiente'`
                } else {
                    query = sql`${query} AND c.estado_liquidacion = ${estado}`
                }
            }

            query = sql`${query} ORDER BY c.creado_en DESC LIMIT ${limit} OFFSET ${offset}`

            const consumos = await query

            return consumos.map(c => ({
                consumoId: c.id,
                staffId: c.usuario_id,
                staffNombre: c.staff_nombre,
                puntoVentaId: c.punto_venta_id,
                puntoVentaNombre: c.punto_venta_nombre,
                items: c.items,
                totalVenta: c.total_venta,
                totalCosto: c.total_costo,
                estadoLiquidacion: c.estado_liquidacion,
                creadoEn: c.creado_en,
                liquidadoEn: c.liquidado_en,
                liquidacion: c.regla_aplicada ? {
                    reglaAplicada: c.regla_aplicada,
                    montoCobrado: c.monto_cobrado,
                    motivo: c.motivo
                } : null
            }))
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    // Liquidar consumos (cobrar/perdonar)
    fastify.post('/consumos/liquidar', async (request, reply) => {
        try {
            const { consumoIds, reglaAplicada, valorRegla, motivo, medioPago } = liquidarConsumosSchema.parse(request.body)

            const token = request.headers.authorization?.replace('Bearer ', '')
            const sesionAdmin = token ? await authService.verifySession(token) : null
            const adminId = sesionAdmin?.usuario_id ?? null

            // Obtener consumos
            const consumos = await sql`
                SELECT
                    c.id,
                    c.usuario_id,
                    c.punto_venta_id,
                    c.total_venta,
                    c.total_costo,
                    pv.empresa_id
                FROM consumos_staff c
                JOIN puntos_venta pv ON pv.id = c.punto_venta_id
                WHERE c.id = ANY(${consumoIds})
                AND c.estado_liquidacion = 'pendiente'
            `

            const idsPendientes = consumos.map((c) => c.id)
            const setPendientes = new Set(idsPendientes)
            const idsOmitidos = consumoIds.filter((id) => !setPendientes.has(id))

            if (consumos.length === 0) {
                return {
                    success: true,
                    liquidados: 0,
                    omitidos: consumoIds.length,
                    idsOmitidos: consumoIds,
                    montoCobradoTotal: 0,
                    mensaje: 'No se encontraron consumos pendientes para liquidar'
                }
            }

            // Calcular monto cobrado según regla
            const liquidaciones = consumos.map(consumo => {
                let montoCobrado = 0

                switch (reglaAplicada) {
                    case 'precio_venta':
                        montoCobrado = consumo.total_venta
                        break
                    case 'precio_costo':
                        montoCobrado = consumo.total_costo
                        break
                    case 'porcentaje':
                        if (!valorRegla) throw new Error('valorRegla requerido para porcentaje')
                        montoCobrado = (consumo.total_venta * valorRegla) / 100
                        break
                    case 'monto_fijo':
                        if (!valorRegla) throw new Error('valorRegla requerido para monto_fijo')
                        montoCobrado = valorRegla
                        break
                    case 'perdonado':
                        montoCobrado = 0
                        break
                }

                return {
                    consumoId: consumo.id,
                    montoCobrado,
                    usuarioId: consumo.usuario_id,
                    puntoVentaId: consumo.punto_venta_id,
                    empresaId: consumo.empresa_id,
                }
            })

            const obtenerCajaActivaPorPuntoVenta = async (tx: any, empresaId: string, puntoVentaId: string) => {
                const cajas = await tx`
                    SELECT id, abierta
                    FROM cajas
                    WHERE punto_venta_id = ${puntoVentaId}
                      AND empresa_id = ${empresaId}
                      AND activa = true
                    ORDER BY creado_en ASC
                    LIMIT 1
                `

                if (cajas.length > 0) {
                    return { id: cajas[0].id as string, abierta: Boolean(cajas[0].abierta) }
                }

                const nuevas = await tx`
                    INSERT INTO cajas (punto_venta_id, empresa_id, nombre, es_virtual, activa)
                    VALUES (${puntoVentaId}, ${empresaId}, 'Caja Virtual (Auto)', true, true)
                    RETURNING id, abierta
                `

                return { id: nuevas[0].id as string, abierta: Boolean(nuevas[0].abierta) }
            }

            const obtenerMedioPagoPorNombre = async (
                tx: any,
                empresaId: string,
                nombreMedioPago: 'efectivo' | 'tarjeta' | 'transferencia',
            ) => {
                const medios = await tx`
                    SELECT id, nombre
                    FROM medios_pago
                    WHERE nombre ILIKE ${nombreMedioPago}
                      AND (empresa_id = ${empresaId} OR empresa_id IS NULL)
                    ORDER BY CASE WHEN empresa_id = ${empresaId} THEN 0 ELSE 1 END, creado_en ASC
                    LIMIT 1
                `

                if (medios.length > 0) {
                    return { id: medios[0].id as string, nombre: String(medios[0].nombre || nombreMedioPago) }
                }

                return { id: null as string | null, nombre: nombreMedioPago }
            }

            let transaccionesGeneradas = 0
            let montoEnCaja = 0
            let montoFueraCaja = 0

            // Crear liquidaciones y actualizar consumos en transacción
            await sql.begin(async (txn: any) => {
                const cacheCaja = new Map<string, { id: string; abierta: boolean }>()
                const cacheMedioPago = new Map<string, { id: string | null; nombre: string }>()

                // Crear registros de liquidación
                for (const liq of liquidaciones) {
                    await txn`
                        INSERT INTO liquidaciones_consumo (
                            consumo_id,
                            admin_id,
                            regla_aplicada,
                            valor_regla,
                            monto_cobrado,
                            motivo,
                            creado_en
                        )
                        VALUES (
                            ${liq.consumoId},
                            ${adminId},
                            ${reglaAplicada},
                            ${valorRegla || null},
                            ${liq.montoCobrado},
                            ${motivo || null},
                            NOW()
                        )
                    `

                    if (Number(liq.montoCobrado) > 0) {
                        const claveCaja = `${liq.empresaId}:${liq.puntoVentaId}`
                        let cajaInfo = cacheCaja.get(claveCaja)
                        if (!cajaInfo) {
                            cajaInfo = await obtenerCajaActivaPorPuntoVenta(txn, liq.empresaId, liq.puntoVentaId)
                            cacheCaja.set(claveCaja, cajaInfo)
                        }

                        let medio = cacheMedioPago.get(liq.empresaId)
                        if (!medio) {
                            medio = await obtenerMedioPagoPorNombre(txn, liq.empresaId, medioPago || 'efectivo')
                            cacheMedioPago.set(liq.empresaId, medio)
                        }

                        const fueraCaja = !cajaInfo.abierta

                        await txn`
                            INSERT INTO transacciones (
                                tipo,
                                punto_venta_id,
                                caja_id,
                                usuario_id,
                                empresa_id,
                                estado,
                                subtotal,
                                total,
                                medio_pago_id,
                                medio_pago_nombre,
                                fuera_caja,
                                fuera_caja_estado,
                                confirmado_en
                            )
                            VALUES (
                                'consumo_staff',
                                ${liq.puntoVentaId},
                                ${cajaInfo.id},
                                ${liq.usuarioId},
                                ${liq.empresaId},
                                'confirmada',
                                ${liq.montoCobrado},
                                ${liq.montoCobrado},
                                ${medio.id},
                                ${medio.nombre},
                                ${fueraCaja},
                                ${fueraCaja ? 'pendiente_caja' : null},
                                NOW()
                            )
                        `

                        transaccionesGeneradas += 1
                        if (fueraCaja) {
                            montoFueraCaja += Number(liq.montoCobrado)
                        } else {
                            montoEnCaja += Number(liq.montoCobrado)
                        }
                    }
                }

                // Actualizar estado de consumos
                const nuevoEstado = reglaAplicada === 'perdonado' ? 'perdonado' :
                    liquidaciones.some(l => l.montoCobrado > 0 && l.montoCobrado < consumos.find(c => c.id === l.consumoId)!.total_venta) ? 'parcial' :
                        'cobrado'

                await txn`
                    UPDATE consumos_staff
                    SET estado_liquidacion = ${nuevoEstado},
                        liquidado_en = NOW()
                    WHERE id = ANY(${idsPendientes})
                `
            })

            await logAuditEvent({
                empresaId: liquidaciones[0]?.empresaId || await getEmpresaIdFromRequest(request),
                accion: 'consumo_liquidado',
                entidad: 'consumo_staff',
                metadata: {
                    consumoIds,
                    idsPendientes,
                    idsOmitidos,
                    reglaAplicada,
                    valorRegla: valorRegla ?? null,
                    montoCobradoTotal: liquidaciones.reduce((sum, l) => sum + l.montoCobrado, 0),
                    medioPago: medioPago || 'efectivo',
                    transaccionesGeneradas,
                    montoEnCaja,
                    montoFueraCaja,
                },
                request
            })

            return {
                success: true,
                liquidados: liquidaciones.length,
                omitidos: idsOmitidos.length,
                idsOmitidos,
                reglaAplicada,
                montoCobradoTotal: liquidaciones.reduce((sum, l) => sum + l.montoCobrado, 0),
                transaccionesGeneradas,
                montoEnCaja,
                montoFueraCaja,
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    // Historial de consumos por staff
    fastify.get('/consumos/staff/:staffId', async (request, reply) => {
        try {
            const { staffId } = request.params as { staffId: string }
            const { fechaDesde, fechaHasta, estado, limit = 50, offset = 0 } = request.query as {
                fechaDesde?: string
                fechaHasta?: string
                estado?: string
                limit?: number
                offset?: number
            }

            let query = sql`
                SELECT 
                    c.id,
                    c.usuario_id,
                    c.punto_venta_id,
                    pv.nombre as punto_venta_nombre,
                    c.items,
                    c.total_venta,
                    c.total_costo,
                    c.estado_liquidacion,
                    c.creado_en,
                    c.liquidado_en,
                    l.regla_aplicada,
                    l.monto_cobrado,
                    l.motivo
                FROM consumos_staff c
                JOIN puntos_venta pv ON c.punto_venta_id = pv.id
                LEFT JOIN liquidaciones_consumo l ON c.id = l.consumo_id
                WHERE c.usuario_id = ${staffId}
            `

            if (fechaDesde) {
                query = sql`${query} AND c.creado_en >= ${fechaDesde}::timestamp`
            }
            if (fechaHasta) {
                query = sql`${query} AND c.creado_en <= ${fechaHasta}::timestamp`
            }
            if (estado) {
                query = sql`${query} AND c.estado_liquidacion = ${estado}`
            }

            query = sql`${query} ORDER BY c.creado_en DESC LIMIT ${limit} OFFSET ${offset}`

            const consumos = await query

            return consumos.map(c => ({
                consumoId: c.id,
                staffId: c.usuario_id,
                puntoVentaId: c.punto_venta_id,
                puntoVentaNombre: c.punto_venta_nombre,
                items: c.items,
                totalVenta: c.total_venta,
                totalCosto: c.total_costo,
                estadoLiquidacion: c.estado_liquidacion,
                creadoEn: c.creado_en,
                liquidadoEn: c.liquidado_en,
                liquidacion: c.regla_aplicada ? {
                    reglaAplicada: c.regla_aplicada,
                    montoCobrado: c.monto_cobrado,
                    motivo: c.motivo
                } : null
            }))
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    // Cancelacion rapida de consumo (ventana corta, mismo staff y PV)
    fastify.post('/consumos/:id/cancelar-rapido', async (request, reply) => {
        try {
            const { id } = request.params as { id: string }
            const { staffId, puntoVentaId } = cancelarRapidoConsumoSchema.parse(request.body)
            const empresaId = await obtenerEmpresaIdPorPuntoVenta(puntoVentaId)

            const consumos = await sql`
                SELECT c.id, c.usuario_id, c.punto_venta_id, c.creado_en, c.total_venta, c.estado_liquidacion
                FROM consumos_staff c
                JOIN puntos_venta pv ON pv.id = c.punto_venta_id
                WHERE c.id = ${id}
                AND pv.empresa_id = ${empresaId}
                LIMIT 1
            `

            if (consumos.length === 0) {
                return reply.code(404).send({ error: 'Consumo no encontrado' })
            }

            const consumo = consumos[0]

            if (consumo.usuario_id !== staffId || consumo.punto_venta_id !== puntoVentaId) {
                return reply.code(403).send({ error: 'No permitido para este consumo' })
            }

            if (consumo.estado_liquidacion !== 'pendiente') {
                return reply.code(400).send({ error: 'Este consumo ya no se puede cancelar' })
            }

            const createdAt = consumo.creado_en ? new Date(consumo.creado_en).getTime() : 0
            const diffMs = Date.now() - createdAt
            if (!createdAt || diffMs > 5000) {
                return reply.code(400).send({ error: 'Ventana de cancelación expirada' })
            }

            await sql`
                DELETE FROM consumos_staff
                WHERE id = ${id}
            `

            await logAuditEvent({
                empresaId,
                usuarioId: staffId,
                accion: 'consumo_cancelado_rapido',
                entidad: 'consumo_staff',
                entidadId: id,
                metadata: {
                    puntoVentaId,
                    totalVenta: Number(consumo.total_venta),
                },
                request
            })

            return { success: true, consumoId: id }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            if ((err as any)?.codigo === 'CAJA_CERRADA_BLOQUEADA') {
                return reply.code(409).send({
                    error: 'CAJA_CERRADA_BLOQUEADA',
                    mensaje: (err as Error).message,
                })
            }
            if ((err as any)?.codigo === 'FUERA_CAJA_DESHABILITADO') {
                return reply.code(409).send({
                    error: 'FUERA_CAJA_DESHABILITADO',
                    mensaje: (err as Error).message,
                })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })
}

export default consumosRoutes
