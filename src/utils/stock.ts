import sql from '../db-admin.js'

export async function reintegrarStockPorAnulacion(params: { transaccionId: string; puntoVentaId: string }) {
  await sql.begin(async (tx: any) => {
    const detalles = await tx<{ item_id: string; cantidad: number }[]>`
      SELECT td.item_id, COALESCE(SUM(td.cantidad), 0) as cantidad
      FROM transaccion_detalles td
      JOIN items i ON i.id = td.item_id
      WHERE td.transaccion_id = ${params.transaccionId}
        AND td.item_id IS NOT NULL
        AND i.maneja_stock = true
      GROUP BY td.item_id
    `

    if (detalles.length === 0) {
      return
    }

    for (const detalle of detalles) {
      await tx`
        INSERT INTO items_punto_venta (
          item_id,
          punto_venta_id,
          activo_en_pv,
          stock_actual_pv,
          stock_minimo_pv
        )
        VALUES (
          ${detalle.item_id},
          ${params.puntoVentaId},
          true,
          0,
          0
        )
        ON CONFLICT (item_id, punto_venta_id)
        DO NOTHING
      `

      await tx`
        UPDATE items_punto_venta
        SET stock_actual_pv = COALESCE(stock_actual_pv, 0) + ${Number(detalle.cantidad)},
            actualizado_en = NOW()
        WHERE item_id = ${detalle.item_id}
          AND punto_venta_id = ${params.puntoVentaId}
      `
    }
  })
}
