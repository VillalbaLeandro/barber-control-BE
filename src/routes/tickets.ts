import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import sql from '../db.js'

// Schemas de validación
const crearTicketSchema = z.object({
    staffId: z.string().uuid().optional(),
    puntoVentaId: z.string().uuid()
})

const agregarItemSchema = z.object({
    tipo: z.enum(['servicio', 'producto']),
    itemId: z.string().uuid(),
    cantidad: z.number().positive(),
    precio: z.number().positive()
})

const removerItemSchema = z.object({
    itemIndex: z.number().int().min(0)
})

const ticketRoutes: FastifyPluginAsync = async (fastify, opts) => {
    // Crear nuevo ticket (carrito)
    fastify.post('/ventas/crear-ticket', async (request, reply) => {
        try {
            const { staffId, puntoVentaId } = crearTicketSchema.parse(request.body)

            // Crear ticket temporal (staffId puede ser null para tickets anónimos)
            const ticket = await sql`
                INSERT INTO tickets (usuario_id, punto_venta_id, items, total, estado, creado_en)
                VALUES (${staffId || null}, ${puntoVentaId}, '[]'::jsonb, 0, 'draft', NOW())
                RETURNING id, usuario_id, punto_venta_id, items, total, estado, creado_en
            `

            return {
                ticketId: ticket[0].id,
                staffId: ticket[0].usuario_id,
                puntoVentaId: ticket[0].punto_venta_id,
                items: ticket[0].items,
                total: ticket[0].total,
                estado: ticket[0].estado,
                creadoEn: ticket[0].creado_en
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    // Obtener ticket actual
    fastify.get('/ventas/ticket/:id', async (request, reply) => {
        try {
            const { id } = request.params as { id: string }

            const ticket = await sql`
                SELECT id, usuario_id, punto_venta_id, items, total, estado, creado_en
                FROM tickets
                WHERE id = ${id}
            `

            if (ticket.length === 0) {
                return reply.code(404).send({ error: 'Ticket no encontrado' })
            }

            return {
                ticketId: ticket[0].id,
                staffId: ticket[0].usuario_id,
                puntoVentaId: ticket[0].punto_venta_id,
                items: ticket[0].items,
                total: ticket[0].total,
                estado: ticket[0].estado,
                creadoEn: ticket[0].creado_en
            }
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    // Agregar item al ticket
    // Agregar item al ticket
    fastify.post('/ventas/ticket/:id/agregar-item', async (request, reply) => {
        try {
            const { id } = request.params as { id: string }
            const itemData = agregarItemSchema.parse(request.body)

            // Obtener ticket actual
            const ticketActual = await sql`
                SELECT items, total FROM tickets WHERE id = ${id}
            `

            if (ticketActual.length === 0) {
                return reply.code(404).send({ error: 'Ticket no encontrado' })
            }

            // Agregar nuevo item o actualizar existente
            // Agregar nuevo item
            let items = ticketActual[0].items

            // Parsear items recursivamente para asegurar array
            let attempts = 0;
            while (typeof items === 'string' && attempts < 3) {
                try {
                    items = JSON.parse(items);
                } catch (e) {
                    items = [];
                    break;
                }
                attempts++;
            }

            if (!Array.isArray(items)) {
                items = []
            }

            // Buscar si ya existe el item
            const existingItemIndex = items.findIndex((item: any) =>
                item.tipo === itemData.tipo && item.itemId === itemData.itemId
            )

            if (existingItemIndex !== -1) {
                // Actualizar cantidad
                items[existingItemIndex].cantidad += itemData.cantidad
                items[existingItemIndex].subtotal = items[existingItemIndex].cantidad * items[existingItemIndex].precio
            } else {
                // Agregar nuevo item
                const nuevoItem = {
                    tipo: itemData.tipo,
                    itemId: itemData.itemId,
                    cantidad: itemData.cantidad,
                    precio: itemData.precio,
                    subtotal: itemData.cantidad * itemData.precio
                }
                items.push(nuevoItem)
            }

            // Calcular nuevo total
            const nuevoTotal = items.reduce((sum: number, item: any) => sum + item.subtotal, 0)

            // Actualizar ticket
            const ticketActualizado = await sql`
                UPDATE tickets
                SET items = ${JSON.stringify(items)}::jsonb,
                    total = ${nuevoTotal},
                    actualizado_en = NOW()
                WHERE id = ${id}
                RETURNING id, usuario_id, punto_venta_id, items, total, estado, creado_en
            `

            return {
                ticketId: ticketActualizado[0].id,
                staffId: ticketActualizado[0].usuario_id,
                puntoVentaId: ticketActualizado[0].punto_venta_id,
                items: ticketActualizado[0].items,
                total: Number(ticketActualizado[0].total),
                estado: ticketActualizado[0].estado
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    // Actualizar cantidad de item
    fastify.put('/ventas/ticket/:id/item/:itemId/cantidad', async (request, reply) => {
        try {
            const { id, itemId } = request.params as { id: string, itemId: string }
            const { cantidad } = z.object({ cantidad: z.number().int() }).parse(request.body)

            // Obtener ticket actual
            const ticketActual = await sql`
                SELECT items FROM tickets WHERE id = ${id}
            `

            if (ticketActual.length === 0) {
                return reply.code(404).send({ error: 'Ticket no encontrado' })
            }

            let items = ticketActual[0].items

            // Parsear items recursivamente para asegurar array
            let attempts = 0;
            while (typeof items === 'string' && attempts < 3) {
                try {
                    items = JSON.parse(items);
                } catch (e) {
                    items = [];
                    break;
                }
                attempts++;
            }

            if (!Array.isArray(items)) items = []

            const itemIndex = items.findIndex((item: any) => item.itemId === itemId)

            if (cantidad <= 0) {
                // Eliminar item si cantidad es 0 o menor
                if (itemIndex !== -1) {
                    items.splice(itemIndex, 1)
                }
            } else {
                if (itemIndex !== -1) {
                    items[itemIndex].cantidad = cantidad
                    items[itemIndex].subtotal = items[itemIndex].cantidad * items[itemIndex].precio
                } else {
                    return reply.code(404).send({ error: 'Item no encontrado en el ticket' })
                }
            }

            // Calcular nuevo total
            const nuevoTotal = items.reduce((sum: number, item: any) => sum + item.subtotal, 0)

            // Actualizar ticket
            const ticketActualizado = await sql`
                UPDATE tickets
                SET items = ${JSON.stringify(items)}::jsonb,
                    total = ${nuevoTotal},
                    actualizado_en = NOW()
                WHERE id = ${id}
                RETURNING id, usuario_id, punto_venta_id, items, total, estado, creado_en
            `

            return {
                ticketId: ticketActualizado[0].id,
                staffId: ticketActualizado[0].usuario_id,
                puntoVentaId: ticketActualizado[0].punto_venta_id,
                items: ticketActualizado[0].items,
                total: Number(ticketActualizado[0].total),
                estado: ticketActualizado[0].estado
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    // Remover item del ticket
    fastify.delete('/ventas/ticket/:id/remover-item', async (request, reply) => {
        try {
            const { id } = request.params as { id: string }
            const { itemIndex } = removerItemSchema.parse(request.body)

            // Obtener ticket actual
            const ticketActual = await sql`
                SELECT items FROM tickets WHERE id = ${id}
            `

            if (ticketActual.length === 0) {
                return reply.code(404).send({ error: 'Ticket no encontrado' })
            }

            // Remover item
            // Remover item
            let items = ticketActual[0].items

            // Parsear items recursivamente para asegurar array
            let attempts = 0;
            while (typeof items === 'string' && attempts < 3) {
                try {
                    items = JSON.parse(items);
                } catch (e) {
                    items = [];
                    break;
                }
                attempts++;
            }

            if (!Array.isArray(items)) items = []

            if (itemIndex >= items.length) {
                return reply.code(400).send({ error: 'Índice de item inválido' })
            }

            items.splice(itemIndex, 1)

            // Calcular nuevo total
            const nuevoTotal = items.reduce((sum: number, item: any) => sum + item.subtotal, 0)

            // Actualizar ticket
            const ticketActualizado = await sql`
                UPDATE tickets
                SET items = ${JSON.stringify(items)}::jsonb,
                    total = ${nuevoTotal},
                    actualizado_en = NOW()
                WHERE id = ${id}
                RETURNING id, usuario_id, punto_venta_id, items, total, estado
            `

            return {
                ticketId: ticketActualizado[0].id,
                staffId: ticketActualizado[0].usuario_id,
                puntoVentaId: ticketActualizado[0].punto_venta_id,
                items: ticketActualizado[0].items,
                total: ticketActualizado[0].total,
                estado: ticketActualizado[0].estado
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })
}

export default ticketRoutes
