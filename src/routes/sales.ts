import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import sql from '../db-admin.js'
import { getDefaultEmpresaId, obtenerEmpresaIdPorPuntoVenta } from '../utils/empresa.js'
import { logAuditEvent } from '../utils/audit.js'
import { procesarOperativaCajaEnMovimiento } from '../utils/operativa-runtime.js'

const confirmSaleSchema = z.object({
    staff_id: z.string().uuid(),
    punto_venta_id: z.string().uuid(),
    ticketId: z.string().uuid().optional(),
    items: z.array(z.object({
        tipo: z.enum(['servicio', 'producto']),
        id: z.string(), // Changed to string (UUID)
        cantidad: z.number(),
        precio: z.number()
    })).optional(),
    total: z.number(),
    metodo_pago: z.string(),
    montoInicialApertura: z.number().min(0).optional(),
    accionCajaCerrada: z.enum(['abrir', 'fuera_caja']).optional(),
})

const confirmConsumptionSchema = z.object({
    staff_id: z.string().uuid(),
    items: z.array(z.object({
        producto_id: z.string().uuid().or(z.number()), // Support both for now/legacy
        cantidad: z.number()
    }))
})

const quickCancelSaleSchema = z.object({
    staff_id: z.string().uuid(),
    punto_venta_id: z.string().uuid(),
})

const salesRoutes: FastifyPluginAsync = async (fastify, opts) => {
    fastify.post('/ventas/confirmar', async (request, reply) => {
        console.log('🔹 RECIBIDO POST /ventas/confirmar');
        try {
            console.log('🚀 Confirmando venta payload:', request.body);
            const data = confirmSaleSchema.parse(request.body)

            let itemsToSave = data.items || []

            // 1. Si viene ticketId, cargar items del ticket
            if (data.ticketId) {
                const ticket = await sql`
                    SELECT items, total, estado 
                    FROM tickets 
                    WHERE id = ${data.ticketId}
                `

                if (ticket.length === 0) {
                    return reply.code(404).send({ error: 'Ticket no encontrado' })
                }

                if (ticket[0].estado !== 'draft') {
                    return reply.code(400).send({ error: 'Ticket ya fue procesado' })
                }

                // Parsear items si es string (jsonb a veces devuelve string dependiendo del driver/config)
                let ticketItems = ticket[0].items;
                if (typeof ticketItems === 'string') {
                    try { ticketItems = JSON.parse(ticketItems); } catch (e) { }
                }
                itemsToSave = ticketItems as Array<any>;

                // Validar discrepancia de total (opcional, warning)
                if (Math.abs(Number(ticket[0].total) - data.total) > 0.1) {
                    console.warn('⚠️ Discrepancia total detectada', { db: ticket[0].total, req: data.total });
                }
            }

            if (!itemsToSave || itemsToSave.length === 0) {
                return reply.code(400).send({ error: 'No hay items para confirmar' })
            }

            const resultadoCaja = await procesarOperativaCajaEnMovimiento({
                puntoVentaId: data.punto_venta_id,
                usuarioId: data.staff_id,
                request,
                motivo: 'confirmacion_venta',
                tipoOperacion: 'venta',
                accionCajaCerrada: data.accionCajaCerrada,
                montoInicialApertura: data.montoInicialApertura,
            })

            if (resultadoCaja.requiereDecisionCajaCerrada) {
                if (resultadoCaja.requiereMontoInicialPrimeraVenta) {
                    return reply.code(409).send({
                        error: 'CAJA_REQUIERE_MONTO_INICIAL_PRIMERA_VENTA',
                        mensaje: resultadoCaja.mensajeDecision,
                    })
                }

                return reply.code(409).send({
                    error: 'CAJA_CERRADA_REQUIERE_DECISION',
                    mensaje: resultadoCaja.mensajeDecision,
                    puedeAbrirCaja: resultadoCaja.puedeAbrirCaja,
                    permitirFueraCaja: resultadoCaja.permitirFueraCaja,
                    accionSugerida: resultadoCaja.accionSugerida,
                })
            }

            const empresaId = resultadoCaja.empresaId
            const cajaId = resultadoCaja.cajaId
            const cajaAbierta = resultadoCaja.cajaAbierta

            const fueraCaja = !cajaAbierta;

            // 3. Obtener Medio de Pago ID
            const medios = await sql`
                SELECT id, nombre, ajuste_porcentual FROM medios_pago 
                WHERE nombre ILIKE ${data.metodo_pago}
                AND (empresa_id = ${empresaId} OR empresa_id IS NULL)
            `
            let medioPagoId = medios.length > 0 ? medios[0].id : null;
            let medioPagoNombre = medios.length > 0 ? medios[0].nombre : data.metodo_pago;

            // INICIO TRANSACCIÓN
            const result = await sql.begin(async (tx: any) => {
                // 4. Crear Transacción (Reemplaza a tabla 'ventas')
                console.log('💾 Insertando transacción...');
                const [transaccion] = await tx`
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
                        'venta_cliente',
                        ${data.punto_venta_id},
                        ${cajaId},
                        ${data.staff_id},
                        ${empresaId},
                        'confirmada',
                        ${data.total}, -- Asumimos subtotal = total por ahora (sin impuestos separados)
                        ${data.total},
                        ${medioPagoId},
                        ${medioPagoNombre},
                        ${fueraCaja},
                        ${fueraCaja ? 'pendiente_caja' : null},
                        NOW()
                    )
                    RETURNING id
                `
                const transaccionId = transaccion.id;
                console.log('✅ Transacción creada:', transaccionId);

                // 5. Guardar Detalles de Transacción
                for (const item of itemsToSave) {
                    const itemAny = item as any;
                    const nombreItem = itemAny.nombre || itemAny.name || (itemAny.tipo === 'servicio' ? 'Servicio' : 'Producto');
                    const tipoItem = itemAny.tipo; // 'servicio' o 'producto'
                    const itemId = itemAny.itemId || itemAny.id; // UUID
                    const cantidad = Number(itemAny.cantidad);
                    const precio = Number(itemAny.precio);
                    const totalLinea = cantidad * precio;

                    await tx`
                        INSERT INTO transaccion_detalles (
                            transaccion_id,
                            item_id,       -- NUEVO: Campo unificado obligatorio
                            tipo_item,     -- DEPRECATED: Mantener por compatibilidad
                            servicio_id,   -- DEPRECATED: Mantener por compatibilidad
                            producto_id,   -- DEPRECATED: Mantener por compatibilidad
                            nombre_item,
                            cantidad,
                            precio_unitario_aplicado,
                            subtotal_linea,
                            total_linea
                        )
                        VALUES (
                            ${transaccionId},
                            ${itemId},
                            ${tipoItem},
                            ${tipoItem === 'servicio' ? itemId : null},
                            ${tipoItem === 'producto' ? itemId : null},
                            ${nombreItem},
                            ${cantidad},
                            ${precio},
                            ${totalLinea},
                            ${totalLinea}
                        )
                    `
                }

                // 6. Actualizar Ticket
                if (data.ticketId) {
                    await tx`
                        UPDATE tickets
                        SET estado = 'confirmed', actualizado_en = NOW()
                        WHERE id = ${data.ticketId}
                    `
                }

                return {
                    success: true,
                    venta_id: transaccionId,
                    contexto: {
                        empresa_id: empresaId,
                        punto_venta_id: data.punto_venta_id,
                        caja_id: cajaId,
                        fuera_caja: fueraCaja,
                    },
                };
            });

            await logAuditEvent({
                empresaId,
                usuarioId: data.staff_id,
                accion: 'venta_confirmada',
                entidad: 'transaccion',
                entidadId: result.venta_id,
                metadata: {
                    puntoVentaId: data.punto_venta_id,
                    total: data.total,
                    metodoPago: data.metodo_pago,
                    fueraCaja,
                },
                request
            })

            return result;

        } catch (err) {
            console.error('💥 Error confirmando transacción:', err);
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
            return reply.code(500).send({ error: 'Internal Server Error', details: (err as any).message })
        }
    })

    fastify.post('/ventas/:id/cancelar-rapido', async (request, reply) => {
        try {
            const { id } = request.params as { id: string }
            const data = quickCancelSaleSchema.parse(request.body)
            const empresaId = await obtenerEmpresaIdPorPuntoVenta(data.punto_venta_id)

            const ventas = await sql`
                SELECT id, estado, usuario_id, punto_venta_id, confirmado_en, total
                FROM transacciones
                WHERE id = ${id}
                AND empresa_id = ${empresaId}
                AND tipo = 'venta_cliente'
                LIMIT 1
            `

            if (ventas.length === 0) {
                return reply.code(404).send({ error: 'Venta no encontrada' })
            }

            const venta = ventas[0]

            if (venta.estado === 'anulada') {
                return { success: true, alreadyCancelled: true, venta_id: id }
            }

            if (venta.usuario_id !== data.staff_id || venta.punto_venta_id !== data.punto_venta_id) {
                return reply.code(403).send({ error: 'No permitido para esta venta' })
            }

            const confirmedAt = venta.confirmado_en ? new Date(venta.confirmado_en).getTime() : 0
            const diffMs = Date.now() - confirmedAt
            if (!confirmedAt || diffMs > 5000) {
                return reply.code(400).send({ error: 'Ventana de cancelación expirada' })
            }

            await sql`
                UPDATE transacciones
                SET estado = 'anulada',
                    anulada_en = NOW(),
                    motivo_anulacion = 'Corrección inmediata POS'
                WHERE id = ${id}
            `

            await logAuditEvent({
                empresaId,
                usuarioId: data.staff_id,
                accion: 'venta_cancelada_rapida',
                entidad: 'transaccion',
                entidadId: id,
                metadata: {
                    puntoVentaId: data.punto_venta_id,
                    total: Number(venta.total),
                },
                request
            })

            return { success: true, venta_id: id }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    fastify.post('/consumos/confirmar', async (request, reply) => {
        try {
            const data = confirmConsumptionSchema.parse(request.body)
            const empresaId = await getDefaultEmpresaId();

            // Insertar en consumos_staff usando JSONB para items
            // ya que la tabla detalles_consumo no existe
            const [consumo] = await sql`
                INSERT INTO consumos_staff (
                    staff_id, 
                    punto_venta_id, -- Necesitaríamos PV, pero schema no lo pide. Dejar NULL o buscar staff PV?
                    items, 
                    total_venta, 
                    total_costo, 
                    created_at
                )
                VALUES (
                    ${data.staff_id}, 
                    NULL, -- PV opcional por ahora
                    ${JSON.stringify(data.items)}::jsonb, 
                    0, -- Total venta 0 (consumo interno)
                    0, -- Total costo (deberíamos calcularlo buscando items)
                    NOW()
                )
                RETURNING id
            `

            return { success: true, consumo_id: consumo.id }

        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })
}

export default salesRoutes
