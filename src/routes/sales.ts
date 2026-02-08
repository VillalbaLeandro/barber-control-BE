import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import sql from '../db.js'

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
    metodo_pago: z.string()
})

const confirmConsumptionSchema = z.object({
    staff_id: z.string().uuid(),
    items: z.array(z.object({
        producto_id: z.string().uuid().or(z.number()), // Support both for now/legacy
        cantidad: z.number()
    }))
})

const salesRoutes: FastifyPluginAsync = async (fastify, opts) => {
    fastify.post('/ventas/confirmar', async (request, reply) => {
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

            // 2. Obtener Caja Abierta/Default para el Punto de Venta
            // (La tabla transacciones requiere caja_id NOT NULL)
            const cajas = await sql`
                SELECT id FROM cajas 
                WHERE punto_venta_id = ${data.punto_venta_id} 
                AND activa = true 
                LIMIT 1
            `

            // Si no hay caja, intentar buscar cualquiera del PV, o crear error
            let cajaId = cajas.length > 0 ? cajas[0].id : null;
            if (!cajaId) {
                // Fallback: Buscar "Caja Principal" o cualquiera
                const cualquierCaja = await sql`SELECT id FROM cajas WHERE punto_venta_id = ${data.punto_venta_id} LIMIT 1`
                if (cualquierCaja.length > 0) cajaId = cualquierCaja[0].id;
                else {
                    // Si realmente no hay cajas, no podemos insertar en transacciones
                    return reply.code(500).send({ error: 'No hay cajas configuradas para este punto de venta' })
                }
            }

            // 3. Obtener Medio de Pago ID
            // El frontend manda el nombre (ej: "EFECTIVO"), buscamos el ID
            const medios = await sql`
                SELECT id, nombre, ajuste_porcentual FROM medios_pago 
                WHERE nombre ILIKE ${data.metodo_pago}
            `
            let medioPagoId = medios.length > 0 ? medios[0].id : null;
            let medioPagoNombre = medios.length > 0 ? medios[0].nombre : data.metodo_pago;

            // 4. Crear Transacción (Reemplaza a tabla 'ventas')
            console.log('💾 Insertando transacción...');
            const transaccion = await sql`
                INSERT INTO transacciones (
                    tipo,
                    punto_venta_id,
                    caja_id,
                    staff_id,
                    estado,
                    subtotal,
                    total,
                    medio_pago_id,
                    medio_pago_nombre,
                    confirmado_en
                )
                VALUES (
                    'venta_cliente',
                    ${data.punto_venta_id},
                    ${cajaId},
                    ${data.staff_id},
                    'confirmada',
                    ${data.total}, -- Asumimos subtotal = total por ahora (sin impuestos separados)
                    ${data.total},
                    ${medioPagoId},
                    ${medioPagoNombre},
                    NOW()
                )
                RETURNING id
            `
            const transaccionId = transaccion[0].id;
            console.log('✅ Transacción creada:', transaccionId);

            // 5. Guardar Detalles de Transacción
            for (const item of itemsToSave) {
                const itemAny = item as any;
                // Necesitamos el nombre del item si no viene en el ticket.
                // Intentamos usar el que viene, si no, placeholder.
                // (Idealmente haríamos query para sacar el nombre real, pero por performance confiamos en ticket o ponemos genérico)
                const nombreItem = itemAny.nombre || itemAny.name || (itemAny.tipo === 'servicio' ? 'Servicio' : 'Producto');
                const tipoItem = itemAny.tipo; // 'servicio' o 'producto'
                const itemId = itemAny.itemId || itemAny.id; // UUID
                const cantidad = Number(itemAny.cantidad);
                const precio = Number(itemAny.precio);
                const totalLinea = cantidad * precio;

                await sql`
                    INSERT INTO transaccion_detalles (
                        transaccion_id,
                        tipo_item,
                        servicio_id,
                        producto_id,
                        nombre_item,
                        cantidad,
                        precio_unitario_aplicado,
                        subtotal_linea,
                        total_linea
                    )
                    VALUES (
                        ${transaccionId},
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
                await sql`
                    UPDATE tickets
                    SET estado = 'confirmed', actualizado_en = NOW()
                    WHERE id = ${data.ticketId}
                `
            }

            return { success: true, venta_id: transaccionId }

        } catch (err) {
            console.error('💥 Error confirmando transacción:', err);
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    fastify.post('/consumos/confirmar', async (request, reply) => {
        try {
            const data = confirmConsumptionSchema.parse(request.body)

            // Assuming 'consumos_staff' table
            const consumo = await sql`
                INSERT INTO consumos_staff (staff_id, fecha)
                VALUES (${data.staff_id}, NOW())
                RETURNING id
            `
            const consumoId = consumo[0].id

            for (const item of data.items) {
                await sql`
                    INSERT INTO detalles_consumo (consumo_id, producto_id, cantidad)
                    VALUES (${consumoId}, ${item.producto_id}, ${item.cantidad})
                `
            }

            return { success: true, consumo_id: consumoId }

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
