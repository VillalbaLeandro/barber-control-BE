import { FastifyPluginAsync } from 'fastify'
import sql from '../db.js'
import sqlAdmin from '../db-admin.js'
import { getEmpresaIdFromRequest } from '../utils/empresa.js'

const catalogRoutes: FastifyPluginAsync = async (fastify) => {
  const fetchCatalogItems = async (empresaId: string, puntoVentaId?: string) => {
    return sqlAdmin`
      SELECT
        i.id,
        i.nombre,
        i.categoria_id,
        COALESCE(c.nombre, i.categoria, 'Sin categoría') AS categoria,
        COALESCE(ipv.precio_venta_pv, i.precio_venta) AS precio_venta,
        COALESCE(ipv.activo_en_pv, i.activo) AS activo,
        COALESCE(ipv.orden_ui_pv, i.orden_ui) AS orden_ui,
        i.costo,
        i.maneja_stock,
        CASE
          WHEN i.maneja_stock = true THEN COALESCE(ipv.stock_actual_pv, i.stock_actual)
          ELSE i.stock_actual
        END AS stock_actual,
        CASE
          WHEN i.maneja_stock = true THEN COALESCE(ipv.stock_minimo_pv, i.stock_minimo)
          ELSE i.stock_minimo
        END AS stock_minimo,
        i.permite_consumo_staff,
        i.duracion_min,
        i.tipo_cantidad,
        i.creado_en,
        i.actualizado_en
      FROM items i
      LEFT JOIN categorias_catalogo c ON c.id = i.categoria_id
      LEFT JOIN categorias_punto_venta cpv
        ON cpv.categoria_id = i.categoria_id
       AND cpv.punto_venta_id = ${puntoVentaId ?? null}
      LEFT JOIN items_punto_venta ipv
        ON ipv.item_id = i.id
       AND ipv.punto_venta_id = ${puntoVentaId ?? null}
      WHERE i.empresa_id = ${empresaId}
        AND ${puntoVentaId
          ? sql`i.activo = true AND ipv.punto_venta_id IS NOT NULL AND ipv.activo_en_pv = true AND (i.categoria_id IS NULL OR (c.activa_base = true AND cpv.activa_en_pv = true))`
          : sql`i.activo = true AND (i.categoria_id IS NULL OR c.activa_base = true)`}
      ORDER BY COALESCE(cpv.orden_ui_pv, c.orden_ui_base, 0), COALESCE(ipv.orden_ui_pv, i.orden_ui), i.nombre
    `
  }

  fastify.get('/catalogo/items', async (request) => {
    const empresaId = await getEmpresaIdFromRequest(request)
    const puntoVentaId = request.headers['x-punto-venta-id'] as string | undefined
    const { activo } = request.query as { activo?: boolean }
    const items = await fetchCatalogItems(empresaId, puntoVentaId)
    if (activo === undefined) return items
    return items.filter((i: any) => Boolean(i.activo) === Boolean(activo))
  })

  fastify.get('/catalogo/items/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const empresaId = await getEmpresaIdFromRequest(request)

    const rows = await sql`
      SELECT
        i.id,
        i.nombre,
        i.categoria,
        i.categoria_id,
        i.precio_venta,
        i.activo,
        i.orden_ui,
        i.costo,
        i.maneja_stock,
        i.stock_actual,
        i.stock_minimo,
        i.permite_consumo_staff,
        i.duracion_min,
        i.tipo_cantidad,
        i.creado_en,
        i.actualizado_en
      FROM items i
      WHERE i.id = ${id}
        AND i.empresa_id = ${empresaId}
      LIMIT 1
    `

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Item no encontrado' })
    }

    return rows[0]
  })

  fastify.post('/catalogo/items', async (request, reply) => {
    const data = request.body as any
    const empresaId = await getEmpresaIdFromRequest(request)

    if (!empresaId) {
      return reply.code(400).send({ error: 'No se pudo determinar empresa_id' })
    }

    try {
      const [item] = await sql`
        INSERT INTO items (
          nombre,
          categoria,
          categoria_id,
          precio_venta,
          activo,
          orden_ui,
          costo,
          maneja_stock,
          stock_actual,
          stock_minimo,
          permite_consumo_staff,
          duracion_min,
          tipo_cantidad,
          empresa_id
        )
        VALUES (
          ${data.nombre},
          ${data.categoria || null},
          ${data.categoria_id ?? null},
          ${data.precio_venta},
          ${data.activo ?? true},
          ${data.orden_ui ?? 0},
          ${data.costo ?? 0},
          ${data.maneja_stock ?? false},
          ${data.stock_actual ?? 0},
          ${data.stock_minimo ?? 0},
          ${data.permite_consumo_staff ?? true},
          ${data.duracion_min ?? null},
          ${data.tipo_cantidad ?? null},
          ${empresaId}
        )
        RETURNING *
      `

      return item
    } catch (error: any) {
      return reply.code(500).send({ error: 'Error creando item', detail: error.message })
    }
  })

  fastify.put('/catalogo/items/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const data = request.body as any
    const empresaId = await getEmpresaIdFromRequest(request)

    try {
      const updatedRows = await sql`
        UPDATE items
        SET nombre = COALESCE(${data.nombre}, nombre),
            categoria = COALESCE(${data.categoria}, categoria),
            categoria_id = COALESCE(${data.categoria_id}, categoria_id),
            precio_venta = COALESCE(${data.precio_venta}, precio_venta),
            activo = COALESCE(${data.activo}, activo),
            orden_ui = COALESCE(${data.orden_ui}, orden_ui),
            costo = COALESCE(${data.costo}, costo),
            maneja_stock = COALESCE(${data.maneja_stock}, maneja_stock),
            stock_actual = COALESCE(${data.stock_actual}, stock_actual),
            stock_minimo = COALESCE(${data.stock_minimo}, stock_minimo),
            permite_consumo_staff = COALESCE(${data.permite_consumo_staff}, permite_consumo_staff),
            duracion_min = COALESCE(${data.duracion_min}, duracion_min),
            tipo_cantidad = COALESCE(${data.tipo_cantidad}, tipo_cantidad),
            actualizado_en = NOW()
        WHERE id = ${id}
          AND empresa_id = ${empresaId}
        RETURNING id
      `

      if (updatedRows.length === 0) {
        return reply.code(404).send({ error: 'Item no encontrado' })
      }

      return { success: true, id }
    } catch (error: any) {
      return reply.code(500).send({ error: 'Error actualizando item', detail: error.message })
    }
  })

  fastify.get('/catalogo/categorias', async (request) => {
    const empresaId = await getEmpresaIdFromRequest(request)
    const puntoVentaId = request.headers['x-punto-venta-id'] as string | undefined

    const categorias = puntoVentaId
      ? await sqlAdmin`
          SELECT
            c.id,
            c.nombre,
            COALESCE(cpv.orden_ui_pv, c.orden_ui_base, 0) AS orden_ui,
            COUNT(ipv.item_id)::int AS cantidad_items
          FROM categorias_catalogo c
          LEFT JOIN categorias_punto_venta cpv
            ON cpv.categoria_id = c.id
           AND cpv.punto_venta_id = ${puntoVentaId}
          LEFT JOIN items i
            ON i.categoria_id = c.id
           AND i.empresa_id = c.empresa_id
           AND i.activo = true
          LEFT JOIN items_punto_venta ipv
            ON ipv.item_id = i.id
           AND ipv.punto_venta_id = ${puntoVentaId}
           AND ipv.activo_en_pv = true
          WHERE c.empresa_id = ${empresaId}
            AND c.activa_base = true
            AND COALESCE(cpv.activa_en_pv, true) = true
          GROUP BY c.id, c.nombre, COALESCE(cpv.orden_ui_pv, c.orden_ui_base, 0)
          ORDER BY COALESCE(cpv.orden_ui_pv, c.orden_ui_base, 0), c.nombre
        `
      : await sqlAdmin`
          SELECT
            c.id,
            c.nombre,
            COALESCE(c.orden_ui_base, 0) AS orden_ui,
            COUNT(i.id)::int AS cantidad_items
          FROM categorias_catalogo c
          LEFT JOIN items i
            ON i.categoria_id = c.id
           AND i.empresa_id = c.empresa_id
           AND i.activo = true
          WHERE c.empresa_id = ${empresaId}
            AND c.activa_base = true
          GROUP BY c.id, c.nombre, COALESCE(c.orden_ui_base, 0)
          ORDER BY COALESCE(c.orden_ui_base, 0), c.nombre
        `

    const sinCategoria = puntoVentaId
      ? await sqlAdmin`
          SELECT COUNT(i.id)::int AS cantidad_items
          FROM items i
          JOIN items_punto_venta ipv
            ON ipv.item_id = i.id
           AND ipv.punto_venta_id = ${puntoVentaId}
           AND ipv.activo_en_pv = true
          WHERE i.empresa_id = ${empresaId}
            AND i.activo = true
            AND i.categoria_id IS NULL
        `
      : await sqlAdmin`
          SELECT COUNT(i.id)::int AS cantidad_items
          FROM items i
          WHERE i.empresa_id = ${empresaId}
            AND i.activo = true
            AND i.categoria_id IS NULL
        `

    const resultado = categorias.map((c: any) => ({
      id: c.id,
      nombre: c.nombre,
      orden_ui: Number(c.orden_ui ?? 0),
      cantidad_items: Number(c.cantidad_items ?? 0),
      fallback: false,
    }))

    const cantidadSinCategoria = Number(sinCategoria[0]?.cantidad_items ?? 0)
    if (cantidadSinCategoria > 0) {
      resultado.push({
        id: 'sin_categoria',
        nombre: 'Sin categoría',
        orden_ui: 9999,
        cantidad_items: cantidadSinCategoria,
        fallback: true,
      })
    }

    return resultado
  })

  fastify.get('/catalogo/servicios', async (request) => {
    const empresaId = await getEmpresaIdFromRequest(request)
    const puntoVentaId = request.headers['x-punto-venta-id'] as string | undefined
    return fetchCatalogItems(empresaId, puntoVentaId)
  })

  fastify.get('/catalogo/productos', async (request) => {
    const empresaId = await getEmpresaIdFromRequest(request)
    const puntoVentaId = request.headers['x-punto-venta-id'] as string | undefined
    return fetchCatalogItems(empresaId, puntoVentaId)
  })
}

export default catalogRoutes
