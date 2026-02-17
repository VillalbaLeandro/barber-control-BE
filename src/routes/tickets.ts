import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import sql from '../db-admin.js'

// Schemas de validación
const crearTicketSchema = z.object({
    staffId: z.string().uuid().optional(),
    puntoVentaId: z.string().uuid()
})

const agregarItemSchema = z.object({
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
            const ticketActualizado = await sql.begin(async (tx: any) => {
                const ticketActual = await tx`
                    SELECT items, total FROM tickets WHERE id = ${id} FOR UPDATE
                `

                if (ticketActual.length === 0) {
                    throw new Error('TICKET_NOT_FOUND')
                }

                let items = ticketActual[0].items

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

                const existingItemIndex = items.findIndex((item: any) => item.itemId === itemData.itemId)

                if (existingItemIndex !== -1) {
                    items[existingItemIndex].cantidad += itemData.cantidad
                    items[existingItemIndex].subtotal = items[existingItemIndex].cantidad * items[existingItemIndex].precio
                } else {
                    const nuevoItem = {
                        itemId: itemData.itemId,
                        cantidad: itemData.cantidad,
                        precio: itemData.precio,
                        subtotal: itemData.cantidad * itemData.precio
                    }
                    items.push(nuevoItem)
                }

                const nuevoTotal = items.reduce((sum: number, item: any) => sum + item.subtotal, 0)

                const updated = await tx`
                    UPDATE tickets
                    SET items = ${JSON.stringify(items)}::jsonb,
                        total = ${nuevoTotal},
                        actualizado_en = NOW()
                    WHERE id = ${id}
                    RETURNING id, usuario_id, punto_venta_id, items, total, estado, creado_en
                `

                return updated[0]
            })

            return {
                ticketId: ticketActualizado.id,
                staffId: ticketActualizado.usuario_id,
                puntoVentaId: ticketActualizado.punto_venta_id,
                items: ticketActualizado.items,
                total: Number(ticketActualizado.total),
                estado: ticketActualizado.estado
            }
        } catch (err) {
            if (err instanceof Error && err.message === 'TICKET_NOT_FOUND') {
                return reply.code(404).send({ error: 'Ticket no encontrado' })
            }
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
            const ticketActualizado = await sql.begin(async (tx: any) => {
                const ticketActual = await tx`
                    SELECT items FROM tickets WHERE id = ${id} FOR UPDATE
                `

                if (ticketActual.length === 0) {
                    throw new Error('TICKET_NOT_FOUND')
                }

                let items = ticketActual[0].items

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
                    if (itemIndex !== -1) {
                        items.splice(itemIndex, 1)
                    }
                } else {
                    if (itemIndex !== -1) {
                        items[itemIndex].cantidad = cantidad
                        items[itemIndex].subtotal = items[itemIndex].cantidad * items[itemIndex].precio
                    } else {
                        throw new Error('ITEM_NOT_FOUND')
                    }
                }

                const nuevoTotal = items.reduce((sum: number, item: any) => sum + item.subtotal, 0)

                const updated = await tx`
                    UPDATE tickets
                    SET items = ${JSON.stringify(items)}::jsonb,
                        total = ${nuevoTotal},
                        actualizado_en = NOW()
                    WHERE id = ${id}
                    RETURNING id, usuario_id, punto_venta_id, items, total, estado, creado_en
                `

                return updated[0]
            })

            return {
                ticketId: ticketActualizado.id,
                staffId: ticketActualizado.usuario_id,
                puntoVentaId: ticketActualizado.punto_venta_id,
                items: ticketActualizado.items,
                total: Number(ticketActualizado.total),
                estado: ticketActualizado.estado
            }
        } catch (err) {
            if (err instanceof Error && err.message === 'TICKET_NOT_FOUND') {
                return reply.code(404).send({ error: 'Ticket no encontrado' })
            }
            if (err instanceof Error && err.message === 'ITEM_NOT_FOUND') {
                return reply.code(404).send({ error: 'Item no encontrado en el ticket' })
            }
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
            const ticketActualizado = await sql.begin(async (tx: any) => {
                const ticketActual = await tx`
                    SELECT items FROM tickets WHERE id = ${id} FOR UPDATE
                `

                if (ticketActual.length === 0) {
                    throw new Error('TICKET_NOT_FOUND')
                }

                let items = ticketActual[0].items

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
                    throw new Error('ITEM_INDEX_INVALID')
                }

                items.splice(itemIndex, 1)
                const nuevoTotal = items.reduce((sum: number, item: any) => sum + item.subtotal, 0)

                const updated = await tx`
                    UPDATE tickets
                    SET items = ${JSON.stringify(items)}::jsonb,
                        total = ${nuevoTotal},
                        actualizado_en = NOW()
                    WHERE id = ${id}
                    RETURNING id, usuario_id, punto_venta_id, items, total, estado
                `

                return updated[0]
            })

            return {
                ticketId: ticketActualizado.id,
                staffId: ticketActualizado.usuario_id,
                puntoVentaId: ticketActualizado.punto_venta_id,
                items: ticketActualizado.items,
                total: ticketActualizado.total,
                estado: ticketActualizado.estado
            }
        } catch (err) {
            if (err instanceof Error && err.message === 'TICKET_NOT_FOUND') {
                return reply.code(404).send({ error: 'Ticket no encontrado' })
            }
            if (err instanceof Error && err.message === 'ITEM_INDEX_INVALID') {
                return reply.code(400).send({ error: 'Índice de item inválido' })
            }
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })
}

export default ticketRoutes
