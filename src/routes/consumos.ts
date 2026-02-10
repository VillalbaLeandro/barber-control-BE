import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import sql from '../db.js'

// Schemas de validación
const registrarConsumoSchema = z.object({
    staffId: z.string().uuid(),
    puntoVentaId: z.string().uuid(),
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
    motivo: z.string().optional()
})

const consumosRoutes: FastifyPluginAsync = async (fastify, opts) => {
    // Registrar consumo del staff
    fastify.post('/consumos/registrar', async (request, reply) => {
        try {
            console.log('📦 Registrando consumo, body:', JSON.stringify(request.body, null, 2));
            const { staffId, puntoVentaId, items } = registrarConsumoSchema.parse(request.body)

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
            const { consumoIds, reglaAplicada, valorRegla, motivo } = liquidarConsumosSchema.parse(request.body)

            // TODO: Validar permisos de admin (cuando tengamos autenticación admin)
            const adminId = null // Por ahora null, luego será el ID del admin autenticado

            // Obtener consumos
            const consumos = await sql`
                SELECT id, total_venta, total_costo
                FROM consumos_staff
                WHERE id = ANY(${consumoIds})
                AND estado_liquidacion = 'pendiente'
            `

            if (consumos.length === 0) {
                return reply.code(404).send({ error: 'No se encontraron consumos pendientes' })
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
                    montoCobrado
                }
            })

            // Crear liquidaciones y actualizar consumos en transacción
            await sql.begin(async (txn: any) => {
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
                }

                // Actualizar estado de consumos
                const nuevoEstado = reglaAplicada === 'perdonado' ? 'perdonado' :
                    liquidaciones.some(l => l.montoCobrado > 0 && l.montoCobrado < consumos.find(c => c.id === l.consumoId)!.total_venta) ? 'parcial' :
                        'cobrado'

                await txn`
                    UPDATE consumos_staff
                    SET estado_liquidacion = ${nuevoEstado},
                        liquidado_en = NOW()
                    WHERE id = ANY(${consumoIds})
                `
            })

            return {
                success: true,
                liquidados: liquidaciones.length,
                reglaAplicada,
                montoCobradoTotal: liquidaciones.reduce((sum, l) => sum + l.montoCobrado, 0)
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
}

export default consumosRoutes
