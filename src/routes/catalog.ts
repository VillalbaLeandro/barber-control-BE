import { FastifyPluginAsync } from 'fastify';
import sql from '../db.js';
import { z } from 'zod';
import type { Item, ItemCompleto } from '../types/items.js';
import { getEmpresaIdFromRequest } from '../utils/empresa.js';

const catalogRoutes: FastifyPluginAsync = async (fastify) => {

    // GET /catalogo/items - Lista de items (solo tabla base)
    fastify.get('/catalogo/items', async (request, reply) => {
        const { tipo, activo } = request.query as { tipo?: string; activo?: boolean };

        const items = await sql<Item[]>`
            SELECT * FROM items
            WHERE ${activo !== undefined ? sql`activo = ${activo}` : sql`activo = true`}
            ${tipo ? sql`AND tipo = ${tipo}` : sql``}
            ORDER BY tipo, orden_ui, nombre
        `;

        return items;
    });

    // GET /catalogo/items/:id - Item completo con detalles
    fastify.get('/catalogo/items/:id', async (request, reply) => {
        const { id } = request.params as { id: string };

        // Obtener item base
        const items = await sql<Item[]>`
            SELECT * FROM items WHERE id = ${id}
        `;

        if (items.length === 0) {
            return reply.code(404).send({ error: 'Item no encontrado' });
        }

        const item = items[0];

        // Obtener detalles según tipo
        let detalle;
        let comboItems;

        switch (item.tipo) {
            case 'producto':
                [detalle] = await sql`
                    SELECT * FROM items_producto WHERE item_id = ${id}
                `;
                break;

            case 'servicio':
                [detalle] = await sql`
                    SELECT * FROM items_servicio WHERE item_id = ${id}
                `;
                break;

            case 'combo':
                [detalle] = await sql`
                    SELECT * FROM items_combo WHERE item_id = ${id}
                `;

                // Obtener items del combo
                comboItems = await sql`
                    SELECT cd.*, i.nombre
                    FROM combos_detalle cd
                    JOIN items i ON cd.item_id = i.id
                    WHERE cd.combo_id = ${id}
                `;
                break;
        }

        return {
            item,
            detalle,
            ...(item.tipo === 'combo' && { items: comboItems })
        };
    });

    // POST /catalogo/items - Crear item (CON TRANSACCIÓN)
    fastify.post('/catalogo/items', async (request, reply) => {
        const data = request.body as any;
        const empresaId = await getEmpresaIdFromRequest(request);

        if (!empresaId) {
            return reply.code(400).send({ error: 'No se pudo determinar empresa_id' });
        }



        try {
            // Transacción: agrupa los 2 INSERTs y el trigger se valida al final
            const newItem = await sql.begin(async (tx: any) => {
                // 1. Insertar en tabla base
                const [item] = await tx`
                    INSERT INTO items (tipo, nombre, categoria, precio_venta, activo, orden_ui, empresa_id)
                    VALUES (
                        ${data.tipo}::item_tipo,
                        ${data.nombre}, 
                        ${data.categoria || null}, 
                        ${data.precio_venta}, 
                        ${data.activo ?? true}, 
                        ${data.orden_ui ?? 0}, 
                        ${empresaId}
                    )
                    RETURNING *
                `;


                // 2. Insertar detalles según tipo
                switch (data.tipo) {
                    case 'producto':
                        await tx`
                            INSERT INTO items_producto (
                                item_id, costo, maneja_stock, stock_actual, 
                                stock_minimo, permite_consumo_staff
                            )
                            VALUES (
                                ${item.id}, 
                                ${data.costo ?? 0}, 
                                ${data.maneja_stock ?? false},
                                ${data.stock_actual ?? 0}, 
                                ${data.stock_minimo ?? 0},
                                ${data.permite_consumo_staff ?? true}
                            )
                        `;
                        break;

                    case 'servicio':
                        await tx`
                            INSERT INTO items_servicio (item_id, duracion_min)
                            VALUES (${item.id}, ${data.duracion_min ?? null})
                        `;
                        break;

                    case 'combo':
                        await tx`INSERT INTO items_combo (item_id) VALUES (${item.id})`;

                        // Insertar items del combo si existen
                        if (data.items && data.items.length > 0) {
                            for (const comboItem of data.items) {
                                await tx`
                                    INSERT INTO combos_detalle (combo_id, item_id, cantidad)
                                    VALUES (${item.id}, ${comboItem.item_id}, ${comboItem.cantidad ?? 1})
                                `;
                            }
                        }
                        break;
                }

                // Al salir del sql.begin(), hace COMMIT y el trigger valida
                return item;
            });
            return newItem;
        } catch (error: any) {
            console.error('❌ Error creating item:', error);
            return reply.code(500).send({
                error: 'Error creando item',
                detail: error.message
            });
        }
    });

    // PUT /catalogo/items/:id - Actualizar item
    fastify.put('/catalogo/items/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const data = request.body as any;
        const empresaId = await getEmpresaIdFromRequest(request);

        if (!empresaId) {
            return reply.code(400).send({ error: 'No se pudo determinar empresa_id' });
        }

        try {
            await sql.begin(async (tx: any) => {
                // 1. Actualizar tabla base
                // RLS asegura que solo se actualice si pertenece a la empresa
                const [updatedItem] = await tx`
                    UPDATE items
                    SET nombre = ${data.nombre},
                        categoria = ${data.categoria || null},
                        precio_venta = ${data.precio_venta},
                        activo = ${data.activo},
                        orden_ui = ${data.orden_ui ?? 0},
                        actualizado_en = NOW()
                    WHERE id = ${id}
                    RETURNING tipo
                `;

                if (!updatedItem) {
                    throw new Error('Item no encontrado o no pertenece a su empresa');
                }

                // 2. Actualizar detalles según tipo
                switch (updatedItem.tipo) {
                    case 'producto':
                        await tx`
                            UPDATE items_producto
                            SET costo = ${data.costo ?? 0},
                                maneja_stock = ${data.maneja_stock ?? false},
                                stock_actual = ${data.stock_actual ?? 0},
                                stock_minimo = ${data.stock_minimo ?? 0},
                                permite_consumo_staff = ${data.permite_consumo_staff ?? true}
                            WHERE item_id = ${id}
                        `;
                        break;

                    case 'servicio':
                        await tx`
                            UPDATE items_servicio
                            SET duracion_min = ${data.duracion_min ?? null}
                            WHERE item_id = ${id}
                        `;
                        break;

                    case 'combo':
                        // Actualizar items del combo si se proveen
                        if (data.items) {
                            // Eliminar items existentes
                            await tx`DELETE FROM combos_detalle WHERE combo_id = ${id}`;

                            // Insertar nuevos items
                            if (data.items.length > 0) {
                                for (const comboItem of data.items) {
                                    await tx`
                                        INSERT INTO combos_detalle (combo_id, item_id, cantidad)
                                        VALUES (${id}, ${comboItem.item_id}, ${comboItem.cantidad ?? 1})
                                    `;
                                }
                            }
                        }
                        break;
                }
            });

            return { success: true, id };
        } catch (error: any) {
            console.error('Error updating item:', error);
            // Si el error es "Item no encontrado", devolver 404
            if (error.message.includes('Item no encontrado')) {
                return reply.code(404).send({ error: 'Item no encontrado' });
            }
            return reply.code(500).send({
                error: 'Error actualizando item',
                detail: error.message
            });
        }
    });

    // DELETE /catalogo/items/:id - Eliminar item
    fastify.delete('/catalogo/items/:id', async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
            // El CASCADE en las FK se encarga de eliminar los detalles
            await sql`DELETE FROM items WHERE id = ${id}`;

            return { success: true };
        } catch (error: any) {
            console.error('Error deleting item:', error);
            return reply.code(500).send({
                error: 'Error eliminando item',
                detail: error.message
            });
        }
    });

    // ========================================
    // Rutas de compatibilidad (deprecated)
    // ========================================

    // GET /catalogo/servicios - Mantener compatibilidad
    fastify.get('/catalogo/servicios', async (request, reply) => {
        const items = await sql`
            SELECT i.*, s.duracion_min
            FROM items i
            JOIN items_servicio s ON i.id = s.item_id
            WHERE i.tipo = 'servicio'::item_tipo AND i.activo = true
            ORDER BY i.orden_ui, i.nombre
        `;
        return items;
    });

    // GET /catalogo/productos - Mantener compatibilidad
    fastify.get('/catalogo/productos', async (request, reply) => {
        const items = await sql`
            SELECT i.*, p.costo, p.maneja_stock, p.stock_actual, 
                   p.stock_minimo, p.permite_consumo_staff
            FROM items i
            JOIN items_producto p ON i.id = p.item_id
            WHERE i.tipo = 'producto'::item_tipo AND i.activo = true
            ORDER BY i.orden_ui, i.nombre
        `;
        return items;
    });
};

export default catalogRoutes;
