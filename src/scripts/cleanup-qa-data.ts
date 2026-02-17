import sqlAdmin from '../db-admin.js'

type CountRow = { c: number }

async function countLike(tableName: 'items' | 'categorias_catalogo' | 'puntos_venta'): Promise<number> {
  const rows = await sqlAdmin<CountRow[]>`
    SELECT COUNT(*)::int AS c
    FROM ${sqlAdmin(tableName)}
    WHERE nombre LIKE 'QA %'
  `
  return Number(rows[0]?.c ?? 0)
}

async function run(): Promise<void> {
  const before = {
    items: await countLike('items'),
    categorias: await countLike('categorias_catalogo'),
    puntosVenta: await countLike('puntos_venta'),
  }

  await sqlAdmin.begin(async (tx: any) => {
    await tx`
      DELETE FROM items i
      WHERE i.nombre LIKE 'QA %'
        AND NOT EXISTS (
          SELECT 1
          FROM transaccion_detalles td
          WHERE td.item_id = i.id
        )
    `

    await tx`
      UPDATE items
      SET activo = false,
          actualizado_en = NOW()
      WHERE nombre LIKE 'QA %'
    `

    await tx`DELETE FROM categorias_catalogo WHERE nombre LIKE 'QA %'`
    await tx`DELETE FROM puntos_venta WHERE nombre LIKE 'QA %'`
  })

  const after = {
    items: await countLike('items'),
    categorias: await countLike('categorias_catalogo'),
    puntosVenta: await countLike('puntos_venta'),
  }

  console.log(JSON.stringify({ before, after }, null, 2))
  await sqlAdmin.end({ timeout: 1 })
}

run().catch(async (error) => {
  console.error('cleanup-qa-data failed:', error)
  await sqlAdmin.end({ timeout: 1 })
  process.exit(1)
})
