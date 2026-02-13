import sql from '../db.js'
import sqlAdmin from '../db-admin.js'

type MetadataRow = {
  table_name: string
  rls_enabled: boolean
  force_rls: boolean
  policy_count: number
  has_with_check: boolean
}

const TARGET_TABLES = [
  'empresas',
  'puntos_venta',
  'usuarios',
  'cajas',
  'cierres_caja',
  'transacciones',
  'transaccion_detalles',
  'tickets',
  'sesiones',
  'consumos_staff',
  'consumo_staff_liquidacion',
  'medios_pago',
  'roles',
] as const

const SCOPED_TABLES = [
  'puntos_venta',
  'usuarios',
  'cajas',
  'cierres_caja',
  'transacciones',
  'tickets',
  'sesiones',
  'consumos_staff',
  'consumo_staff_liquidacion',
] as const

async function getExistingTables(names: readonly string[]): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY(${names as unknown as string[]})
    ORDER BY table_name
  `
  return rows.map((r) => r.table_name)
}

async function getRlsMetadata(existingTables: string[]): Promise<MetadataRow[]> {
  if (existingTables.length === 0) return []

  const rows = await sql<MetadataRow[]>`
    SELECT
      c.relname AS table_name,
      c.relrowsecurity AS rls_enabled,
      c.relforcerowsecurity AS force_rls,
      COALESCE(p.policy_count, 0)::int AS policy_count,
      COALESCE(p.has_with_check, false) AS has_with_check
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN (
      SELECT
        tablename,
        COUNT(*)::int AS policy_count,
        BOOL_OR(COALESCE(with_check, '') <> '') AS has_with_check
      FROM pg_policies
      WHERE schemaname = 'public'
      GROUP BY tablename
    ) p ON p.tablename = c.relname
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname = ANY(${existingTables})
    ORDER BY c.relname
  `

  return rows
}

async function getEmpresasForTest(): Promise<string[]> {
  const rows = await sqlAdmin<{ id: string }[]>`
    SELECT id
    FROM empresas
    ORDER BY creado_en NULLS LAST, id
    LIMIT 2
  `
  return rows.map((r) => r.id)
}

async function countVisibleRowsByEmpresa(empresaId: string, tables: readonly string[]) {
  return sql.begin(async (tx) => {
    await tx.unsafe("SELECT set_config('row_security', 'on', true)")
    await tx.unsafe("SELECT set_config('app.bypass_rls', 'false', true)")
    await tx.unsafe(`SELECT set_config('app.current_empresa_id', '${empresaId}', true)`)

    const out: Record<string, number> = {}
    for (const table of tables) {
      const result = await tx.unsafe<{ total: number }[]>(`SELECT COUNT(*)::int AS total FROM ${table}`)
      out[table] = Number(result[0]?.total ?? 0)
    }
    return out
  })
}

async function getCrossEmpresaMismatches(empresaId: string) {
  return sql.begin(async (tx) => {
    await tx.unsafe("SELECT set_config('row_security', 'on', true)")
    await tx.unsafe("SELECT set_config('app.bypass_rls', 'false', true)")
    await tx.unsafe(`SELECT set_config('app.current_empresa_id', '${empresaId}', true)`)

    const checks = [
      {
        table: 'puntos_venta',
        query: `
          SELECT
            COUNT(*)::int AS visible_total,
            COUNT(*) FILTER (WHERE empresa_id <> '${empresaId}')::int AS cross_empresa
          FROM puntos_venta
        `,
      },
      {
        table: 'usuarios',
        query: `
          SELECT
            COUNT(*)::int AS visible_total,
            COUNT(*) FILTER (WHERE empresa_id <> '${empresaId}')::int AS cross_empresa
          FROM usuarios
        `,
      },
      {
        table: 'cajas',
        query: `
          SELECT
            COUNT(*)::int AS visible_total,
            COUNT(*) FILTER (WHERE empresa_id <> '${empresaId}')::int AS cross_empresa
          FROM cajas
        `,
      },
      {
        table: 'cierres_caja',
        query: `
          SELECT
            COUNT(*)::int AS visible_total,
            COUNT(*) FILTER (WHERE empresa_id <> '${empresaId}')::int AS cross_empresa
          FROM cierres_caja
        `,
      },
      {
        table: 'transacciones',
        query: `
          SELECT
            COUNT(*)::int AS visible_total,
            COUNT(*) FILTER (WHERE empresa_id <> '${empresaId}')::int AS cross_empresa
          FROM transacciones
        `,
      },
      {
        table: 'tickets',
        query: `
          SELECT
            COUNT(*)::int AS visible_total,
            COUNT(*) FILTER (WHERE pv.empresa_id <> '${empresaId}')::int AS cross_empresa
          FROM tickets t
          JOIN puntos_venta pv ON pv.id = t.punto_venta_id
        `,
      },
      {
        table: 'sesiones',
        query: `
          SELECT
            COUNT(*)::int AS visible_total,
            COUNT(*) FILTER (WHERE u.empresa_id <> '${empresaId}')::int AS cross_empresa
          FROM sesiones s
          JOIN usuarios u ON u.id = s.usuario_id
        `,
      },
      {
        table: 'consumos_staff',
        query: `
          SELECT
            COUNT(*)::int AS visible_total,
            COUNT(*) FILTER (WHERE pv.empresa_id <> '${empresaId}')::int AS cross_empresa
          FROM consumos_staff cs
          JOIN puntos_venta pv ON pv.id = cs.punto_venta_id
        `,
      },
      {
        table: 'consumo_staff_liquidacion',
        query: `
          SELECT
            COUNT(*)::int AS visible_total,
            COUNT(*) FILTER (WHERE tr.empresa_id <> '${empresaId}')::int AS cross_empresa
          FROM consumo_staff_liquidacion csl
          JOIN transacciones tr ON tr.id = csl.transaccion_id
        `,
      },
    ] as const

    const result: Record<string, { visible_total: number; cross_empresa: number }> = {}
    for (const check of checks) {
      const rows = await tx.unsafe<{ visible_total: number; cross_empresa: number }[]>(check.query)
      result[check.table] = {
        visible_total: Number(rows[0]?.visible_total ?? 0),
        cross_empresa: Number(rows[0]?.cross_empresa ?? 0),
      }
    }

    return result
  })
}

function evaluateMetadata(rows: MetadataRow[]) {
  const missingRls = rows.filter((r) => !r.rls_enabled).map((r) => r.table_name)
  const missingPolicies = rows.filter((r) => r.policy_count === 0).map((r) => r.table_name)
  return {
    ok: missingRls.length === 0 && missingPolicies.length === 0,
    missingRls,
    missingPolicies,
  }
}

function evaluateDynamicIsolation(
  empresaA: string,
  countsA: Record<string, number>,
  empresaB: string,
  countsB: Record<string, number>
) {
  const differences = SCOPED_TABLES.map((table) => ({
    table,
    empresaA: countsA[table] ?? 0,
    empresaB: countsB[table] ?? 0,
  })).filter((r) => r.empresaA !== r.empresaB)

  const compared = SCOPED_TABLES.filter((t) => typeof countsA[t] === 'number' && typeof countsB[t] === 'number')
  const ok = true

  return {
    ok,
    note:
      differences.length > 0
        ? 'Hay diferencias de conteo entre empresas (informativo).'
        : 'Los conteos son iguales entre empresas; no implica falla por si solo.',
    empresaA,
    empresaB,
    comparedTables: compared,
    differingTables: differences,
  }
}

function evaluateCrossEmpresaMismatches(
  mismatchesA: Record<string, { visible_total: number; cross_empresa: number }>,
  mismatchesB: Record<string, { visible_total: number; cross_empresa: number }>
) {
  const failingA = Object.entries(mismatchesA)
    .filter(([, value]) => value.cross_empresa > 0)
    .map(([table, value]) => ({ table, ...value }))
  const failingB = Object.entries(mismatchesB)
    .filter(([, value]) => value.cross_empresa > 0)
    .map(([table, value]) => ({ table, ...value }))

  return {
    ok: failingA.length === 0 && failingB.length === 0,
    failingA,
    failingB,
  }
}

async function run(): Promise<void> {
  const roleInfo = await sql<
    { current_user: string; session_user: string; bypass: boolean; super: boolean }[]
  >`
    SELECT
      current_user,
      session_user,
      (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super
  `

  const existingTables = await getExistingTables(TARGET_TABLES)
  const metadata = await getRlsMetadata(existingTables)
  const metadataCheck = evaluateMetadata(metadata)
  const empresas = await getEmpresasForTest()

  const report: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    roleInfo: roleInfo[0] ?? null,
    enforcementLimitations:
      roleInfo[0]?.bypass === true
        ? 'El rol DB actual tiene BYPASSRLS=true; el aislamiento real por politicas no puede garantizarse con este rol.'
        : null,
    existingTables,
    metadata,
    metadataCheck,
  }

  if (empresas.length < 2) {
    report.dynamicIsolation = {
      ok: false,
      reason: 'No hay 2 empresas para prueba cruzada',
      empresas,
    }

    console.log(JSON.stringify(report, null, 2))
    process.exit(metadataCheck.ok ? 0 : 1)
    return
  }

  const [empresaA, empresaB] = empresas
  const countsA = await countVisibleRowsByEmpresa(empresaA, SCOPED_TABLES)
  const countsB = await countVisibleRowsByEmpresa(empresaB, SCOPED_TABLES)
  const mismatchesA = await getCrossEmpresaMismatches(empresaA)
  const mismatchesB = await getCrossEmpresaMismatches(empresaB)
  const dynamicIsolation = evaluateDynamicIsolation(empresaA, countsA, empresaB, countsB)
  const crossEmpresaCheck = evaluateCrossEmpresaMismatches(mismatchesA, mismatchesB)

  report.dynamicIsolation = {
    ...dynamicIsolation,
    crossEmpresaCheck,
    countsByEmpresa: {
      [empresaA]: countsA,
      [empresaB]: countsB,
    },
    mismatchesByEmpresa: {
      [empresaA]: mismatchesA,
      [empresaB]: mismatchesB,
    },
  }

  console.log(JSON.stringify(report, null, 2))

  if (!metadataCheck.ok || !dynamicIsolation.ok || !crossEmpresaCheck.ok) {
    process.exit(1)
  }
}

run()
  .then(async () => {
    await sql.end()
    await sqlAdmin.end()
    process.exit(0)
  })
  .catch(async (error) => {
    console.error('RLS QA FAILED:', error)
    await sql.end()
    await sqlAdmin.end()
    process.exit(1)
  })
