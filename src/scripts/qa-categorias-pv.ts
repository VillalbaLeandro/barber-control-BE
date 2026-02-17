import { spawn } from 'child_process'
import sql from '../db.js'
import sqlAdmin from '../db-admin.js'

const QA_PORT = process.env.QA_PORT || '3023'
const BASE_URL = `http://localhost:${QA_PORT}`

type LoginResponse = {
  token: string
}

type PuntoVenta = {
  id: string
  nombre: string
  activo: boolean
}

type PuntoVentaCreado = {
  id: string
  nombre: string
}

type Categoria = {
  id: string
  nombre: string
}

type Item = {
  id: string
}

type CatalogoCategoria = {
  id: string
  nombre: string
  fallback: boolean
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForServer(maxAttempts = 40): Promise<void> {
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const response = await fetch(`${BASE_URL}/`)
      if (response.ok) return
    } catch {
      // retry
    }
    await sleep(500)
  }
  throw new Error(`No se pudo iniciar el servidor QA en ${BASE_URL}`)
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${method} ${path} -> ${response.status}: ${text}`)
  }

  return (await response.json()) as T
}

async function cleanupByPrefix(prefix: string): Promise<void> {
  await sqlAdmin.begin(async (tx: any) => {
    await tx`DELETE FROM items WHERE nombre LIKE ${`${prefix}%`}`
    await tx`DELETE FROM categorias_catalogo WHERE nombre LIKE ${`${prefix}%`}`
    await tx`DELETE FROM puntos_venta WHERE nombre LIKE ${`${prefix}%`}`
  })
}

function assertCondition(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

async function run(): Promise<void> {
  const qaPrefix = `QA CATPV ${Date.now()} `
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    qaPrefix,
  }

  const server = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    shell: true,
    stdio: 'pipe',
    env: { ...process.env, PORT: QA_PORT },
  })

  server.stderr.on('data', (chunk) => {
    process.stderr.write(String(chunk))
  })

  let token = ''

  try {
    await waitForServer()

    const login = await request<LoginResponse>('POST', '/admin/login', {
      email: 'admin',
      password: 'admin123',
    })
    token = login.token

    const puntosVenta = await request<PuntoVenta[]>('GET', '/admin/puntos-venta', undefined, token)
    const pvsActivos = puntosVenta.filter((pv) => pv.activo)

    if (pvsActivos.length < 2) {
      const suffix = Date.now().toString().slice(-6)
      const pvCreado = await request<PuntoVentaCreado>('POST', '/admin/puntos-venta', {
        nombre: `${qaPrefix}PV`,
        codigo: `QAPV${suffix}`,
      }, token)
      pvsActivos.push({ id: pvCreado.id, nombre: pvCreado.nombre, activo: true })
    }

    assertCondition(pvsActivos.length >= 2, 'No se pudo asegurar 2 puntos de venta activos para QA categorias PV')

    const pvA = pvsActivos[0]
    const pvB = pvsActivos[1]

    const categoriaSolo = await request<Categoria>('POST', '/admin/categorias', {
      nombre: `${qaPrefix}SOLO`,
      scope: 'solo_pv',
      puntoVentaId: pvA.id,
    }, token)

    const categoriaPvs = await request<Categoria>('POST', '/admin/categorias', {
      nombre: `${qaPrefix}PVS`,
      scope: 'pvs',
      puntoVentaIds: [pvA.id, pvB.id],
    }, token)

    const categoriaTodos = await request<Categoria>('POST', '/admin/categorias', {
      nombre: `${qaPrefix}TODOS`,
      scope: 'todos_pv',
    }, token)

    const itemSolo = await request<Item>('POST', '/admin/catalogo/items', {
      nombre: `${qaPrefix}SERV SOLO`,
      categoriaId: categoriaSolo.id,
      precio_venta: 1000,
      duracion_min: 20,
      scope: 'solo_pv',
      puntoVentaId: pvA.id,
    }, token)

    const itemPvs = await request<Item>('POST', '/admin/catalogo/items', {
      nombre: `${qaPrefix}PROD PVS`,
      categoriaId: categoriaPvs.id,
      precio_venta: 500,
      costo: 100,
      maneja_stock: true,
      stock_actual: 4,
      stock_minimo: 1,
      scope: 'todos_pv_activos',
    }, token)

    const itemTodos = await request<Item>('POST', '/admin/catalogo/items', {
      nombre: `${qaPrefix}SERV TODOS`,
      categoriaId: categoriaTodos.id,
      precio_venta: 700,
      duracion_min: 25,
      scope: 'todos_pv_activos',
    }, token)

    const itemSinCategoria = await request<Item>('POST', '/admin/catalogo/items', {
      nombre: `${qaPrefix}SERV SINCAT`,
      precio_venta: 0,
      duracion_min: 15,
      scope: 'solo_pv',
      puntoVentaId: pvA.id,
    }, token)

    const categoriasPvA = await request<CatalogoCategoria[]>(
      'GET',
      '/catalogo/categorias',
      undefined,
      token,
      { 'X-Punto-Venta-Id': pvA.id }
    )
    const idsPvA = new Set(categoriasPvA.map((c) => c.id))

    assertCondition(idsPvA.has(categoriaSolo.id), 'PV A debe mostrar categoria SOLO')
    assertCondition(idsPvA.has(categoriaPvs.id), 'PV A debe mostrar categoria PVS')
    assertCondition(idsPvA.has(categoriaTodos.id), 'PV A debe mostrar categoria TODOS')
    assertCondition(idsPvA.has('sin_categoria'), 'PV A debe mostrar tab Sin categoria cuando hay items sin categoria')

    const categoriasPvB = await request<CatalogoCategoria[]>(
      'GET',
      '/catalogo/categorias',
      undefined,
      token,
      { 'X-Punto-Venta-Id': pvB.id }
    )
    const idsPvB = new Set(categoriasPvB.map((c) => c.id))

    assertCondition(!idsPvB.has(categoriaSolo.id), 'PV B no debe mostrar categoria SOLO')
    assertCondition(idsPvB.has(categoriaPvs.id), 'PV B debe mostrar categoria PVS')
    assertCondition(idsPvB.has(categoriaTodos.id), 'PV B debe mostrar categoria TODOS')

    await request('PUT', `/admin/categorias/${categoriaPvs.id}/pv`, {
      puntoVentaId: pvB.id,
      activaEnPv: false,
    }, token)

    const categoriasPvBPost = await request<CatalogoCategoria[]>(
      'GET',
      '/catalogo/categorias',
      undefined,
      token,
      { 'X-Punto-Venta-Id': pvB.id }
    )
    const idsPvBPost = new Set(categoriasPvBPost.map((c) => c.id))
    assertCondition(!idsPvBPost.has(categoriaPvs.id), 'PV B debe ocultar categoria PVS al inactivarla en PV')

    const productosPvB = await request<Array<{ id: string }>>(
      'GET',
      '/catalogo/productos',
      undefined,
      token,
      { 'X-Punto-Venta-Id': pvB.id }
    )
    assertCondition(
      !productosPvB.some((p) => p.id === itemPvs.id),
      'Productos de categoria inactiva en PV no deben verse en /catalogo/productos'
    )

    report.result = 'QA OK'
    report.created = {
      categorias: [categoriaSolo.id, categoriaPvs.id, categoriaTodos.id],
      items: [itemSolo.id, itemPvs.id, itemTodos.id, itemSinCategoria.id],
    }
    report.puntosVenta = {
      pvA: { id: pvA.id, nombre: pvA.nombre },
      pvB: { id: pvB.id, nombre: pvB.nombre },
    }
    report.summary = {
      pvA: categoriasPvA.length,
      pvBBeforeInactivar: categoriasPvB.length,
      pvBAfterInactivar: categoriasPvBPost.length,
    }

    console.log(JSON.stringify(report, null, 2))
  } finally {
    try {
      if (token) {
        await request('POST', '/admin/logout', {}, token)
      }
    } catch {
      // no-op
    }

    await cleanupByPrefix(qaPrefix)
    server.kill('SIGTERM')
    await sleep(1000)
  }
}

run()
  .then(async () => {
    await sql.end()
    await sqlAdmin.end()
    process.exit(0)
  })
  .catch(async (error) => {
    console.error('QA CATEGORIAS PV FAILED:', error)
    await sql.end()
    await sqlAdmin.end()
    process.exit(1)
  })
