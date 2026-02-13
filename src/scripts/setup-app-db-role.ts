import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import postgres from 'postgres'
import dotenv from 'dotenv'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

function ensureRoleName(roleName: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(roleName)) {
    throw new Error(`Nombre de rol invalido: ${roleName}`)
  }
}

function upsertEnv(lines: string[], key: string, value: string): string[] {
  const next = [...lines]
  const index = next.findIndex((line) => line.startsWith(`${key}=`))
  const newLine = `${key}=${value}`
  if (index >= 0) {
    next[index] = newLine
    return next
  }
  next.push(newLine)
  return next
}

async function run(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL
  if (!adminUrl) {
    throw new Error('DATABASE_URL_ADMIN o DATABASE_URL es requerido')
  }

  const roleName = (process.env.APP_DB_ROLE || 'app_backend').trim()
  ensureRoleName(roleName)

  const password = process.env.APP_DB_PASSWORD || crypto.randomBytes(24).toString('base64url')

  const sqlAdmin = postgres(adminUrl, { prepare: false })

  try {
    const roleLit = escapeLiteral(roleName)
    const passLit = escapeLiteral(password)

    const existingRole = await sqlAdmin<{ rolname: string; rolsuper: boolean }[]>`
      SELECT rolname, rolsuper
      FROM pg_roles
      WHERE rolname = ${roleName}
    `

    if (existingRole[0]?.rolsuper) {
      throw new Error(
        `El rol ${roleName} ya existe como superuser. Usa APP_DB_ROLE con otro nombre no privilegiado.`
      )
    }

    await sqlAdmin.begin(async (tx) => {
      await tx.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleLit}') THEN
            EXECUTE 'CREATE ROLE ${roleName} LOGIN PASSWORD ''${passLit}'' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS';
          END IF;
        END
        $$;
      `)

      await tx.unsafe(`GRANT USAGE ON SCHEMA public TO ${roleName}`)
      await tx.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleName}`)
      await tx.unsafe(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${roleName}`)
      await tx.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${roleName}`)

      await tx.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleName}`)
      await tx.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${roleName}`)
      await tx.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${roleName}`)
    })

    const roleInfo = await sqlAdmin<
      { rolname: string; rolbypassrls: boolean; rolsuper: boolean; rolcreaterole: boolean }[]
    >`
      SELECT rolname, rolbypassrls, rolsuper, rolcreaterole
      FROM pg_roles
      WHERE rolname = ${roleName}
    `

    const appUrl = new URL(adminUrl)
    appUrl.username = roleName
    appUrl.password = password

    const envPath = path.join(__dirname, '../../.env')
    const rawEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
    const lines = rawEnv.split(/\r?\n/).filter((line) => line.length > 0)

    const currentDatabaseUrlLine = lines.find((line) => line.startsWith('DATABASE_URL='))
    const currentDatabaseUrl = currentDatabaseUrlLine ? currentDatabaseUrlLine.slice('DATABASE_URL='.length) : adminUrl

    let nextLines = [...lines]
    nextLines = upsertEnv(nextLines, 'DATABASE_URL_ADMIN', currentDatabaseUrl)
    nextLines = upsertEnv(nextLines, 'DATABASE_URL_APP', appUrl.toString())
    nextLines = upsertEnv(nextLines, 'DATABASE_URL', appUrl.toString())
    nextLines = upsertEnv(nextLines, 'APP_DB_ROLE', roleName)

    fs.writeFileSync(envPath, `${nextLines.join('\n')}\n`, 'utf8')

    console.log('Rol de aplicacion configurado correctamente.')
    console.log('Rol:', roleInfo[0]?.rolname)
    console.log('BYPASSRLS:', roleInfo[0]?.rolbypassrls)
    console.log('SUPERUSER:', roleInfo[0]?.rolsuper)
    console.log('CREATEROLE:', roleInfo[0]?.rolcreaterole)
    console.log('Se actualizo backend/.env con DATABASE_URL_APP y DATABASE_URL_ADMIN.')
    console.log('IMPORTANTE: guardar APP_DB_PASSWORD en secreto seguro.')
  } finally {
    await sqlAdmin.end()
  }
}

run().catch((error) => {
  console.error('Error configurando rol de aplicacion:', error)
  process.exit(1)
})
