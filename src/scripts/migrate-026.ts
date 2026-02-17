import sql from '../db-admin.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function runMigration() {
  try {
    console.log('Iniciando migracion 026_backfill_categorias_catalogo...')

    const migrationPath = path.join(__dirname, '../../migrations/026_backfill_categorias_catalogo.sql')
    const migrationSql = fs.readFileSync(migrationPath, 'utf8')
    const sqlWithoutManualTx = migrationSql
      .replace(/^\s*BEGIN;\s*$/gim, '')
      .replace(/^\s*COMMIT;\s*$/gim, '')

    await sql.begin(async (tx) => {
      await tx.unsafe(sqlWithoutManualTx)
    })

    console.log('Migracion 026 ejecutada exitosamente.')
    process.exit(0)
  } catch (err) {
    console.error('Error ejecutando migracion 026:', err)
    process.exit(1)
  }
}

runMigration()
