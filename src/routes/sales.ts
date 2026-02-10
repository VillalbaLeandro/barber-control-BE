import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import sql from '../db.js'
import { getDefaultEmpresaId } from '../utils/empresa.js'

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

            // 2. Obtener Caja Abierta/Default para el Punto de Venta
            const empresaId = await getDefaultEmpresaId();
            const cajas = await sql`
                SELECT id FROM cajas 
                WHERE punto_venta_id = ${data.punto_venta_id} 
                AND empresa_id = ${empresaId}
                AND activa = true 
                LIMIT 1
            `

            // Si no hay caja, intentar buscar cualquiera del PV, o crear una virtual
            let cajaId = cajas.length > 0 ? cajas[0].id : null;
            if (!cajaId) {
                // Fallback: Buscar "Caja Principal" o cualquiera
                const cualquierCaja = await sql`
                    SELECT id FROM cajas 
                    WHERE punto_venta_id = ${data.punto_venta_id} 
                    AND empresa_id = ${empresaId}
                    LIMIT 1
                `
                if (cualquierCaja.length > 0) {
                    cajaId = cualquierCaja[0].id;
                } else {
                    // Auto-crear caja virtual si no existe ninguna
                    console.warn('⚠️ No hay cajas para este PV, creando caja virtual automáticamente');
                    const nuevaCaja = await sql`
                        INSERT INTO cajas (punto_venta_id, empresa_id, nombre, es_virtual, activa)
                        VALUES (${data.punto_venta_id}, ${empresaId}, 'Caja Virtual (Auto)', true, true)
                        RETURNING id
                    `
                    cajaId = nuevaCaja[0].id;
                    console.log('✅ Caja virtual creada:', cajaId);
                }
            }

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

                return { success: true, venta_id: transaccionId };
            });

            return result;

        } catch (err) {
            console.error('💥 Error confirmando transacción:', err);
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            return reply.code(500).send({ error: 'Internal Server Error', details: (err as any).message })
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
