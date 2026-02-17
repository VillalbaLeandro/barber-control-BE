import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import sqlAdmin from '../db-admin'
import { authService } from '../services/auth'
import { getDefaultEmpresaId } from '../utils/empresa'

const PORT = Number(process.env.QA_TEST_PORT || 3015)
const BASE_URL = `http://localhost:${PORT}`

type LoginResponse = {
  token: string
  usuario: { id: string; nombre: string; email: string; rol: string }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let server: ChildProcessWithoutNullStreams | null = null
let adminToken = ''
let adminUserId = ''
let empresaId = ''
let puntoVentaId = ''
let staffId = ''
let servicioId = ''
let cajaId = ''
const createdStaffIds: string[] = []
const createdPuntoVentaIds: string[] = []
const createdItemIds: string[] = []

async function waitForServer(maxAttempts = 45): Promise<void> {
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const response = await fetch(`${BASE_URL}/`)
      if (response.ok) return
    } catch {
      // keep trying
    }
    await sleep(1000)
  }
  throw new Error('No se pudo iniciar el servidor para tests runtime P0')
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  const json = text ? JSON.parse(text) : null
  return { status: response.status, data: json as T }
}

async function ensureQaAdmin(): Promise<{ email: string; password: string; id: string }> {
  const password = 'Qa123456!'
  const email = `qa.runtime.${Date.now()}@local.dev`
  const username = `qa_runtime_${Date.now()}`

  empresaId = await getDefaultEmpresaId()

  const roles = await sqlAdmin`
    SELECT id
    FROM roles
    ORDER BY CASE WHEN lower(nombre) LIKE '%admin%' THEN 0 ELSE 1 END, nombre
    LIMIT 1
  `

  if (roles.length === 0) {
    throw new Error('No hay roles disponibles para admin QA')
  }

  const passwordHash = await authService.hashPassword(password)

  const [usuario] = await sqlAdmin`
    INSERT INTO usuarios (
      nombre_completo,
      correo,
      usuario,
      password_hash,
      rol_id,
      empresa_id,
      activo,
      intentos_fallidos,
      creado_en,
      actualizado_en
    )
    VALUES (
      ${'QA Runtime Admin'},
      ${email},
      ${username},
      ${passwordHash},
      ${roles[0].id},
      ${empresaId},
      true,
      0,
      NOW(),
      NOW()
    )
    RETURNING id
  `

  return { email, password, id: usuario.id as string }
}

async function ensureBaseData(token: string): Promise<void> {
  const puntosVenta = await sqlAdmin<{ id: string }[]>`
    SELECT id
    FROM puntos_venta
    WHERE empresa_id = ${empresaId}
      AND activo = true
    ORDER BY creado_en ASC, id ASC
    LIMIT 1
  `

  if (puntosVenta.length === 0) {
    throw new Error('No hay punto de venta activo para tests')
  }

  puntoVentaId = puntosVenta[0].id

  const items = await sqlAdmin<{ id: string }[]>`
    SELECT id
    FROM items
    WHERE empresa_id = ${empresaId}
      AND tipo = 'servicio'
      AND activo = true
    ORDER BY creado_en ASC, id ASC
    LIMIT 1
  `

  if (items.length > 0) {
    servicioId = items[0].id
  } else {
    const [created] = await sqlAdmin`
      INSERT INTO items (tipo, nombre, categoria, precio_venta, activo, orden_ui, empresa_id)
      VALUES ('servicio', 'QA Runtime Servicio', 'qa', 12000, true, 998, ${empresaId})
      RETURNING id
    `
    servicioId = created.id as string
  }

  const staffResponse = await request<{ id: string; pin: string }>(
    'POST',
    '/admin/staff',
    { nombreCompleto: `QA Staff ${Date.now()}`, rolOperativo: 'barbero' },
    token,
  )

  if (staffResponse.status !== 200) {
    throw new Error(`No se pudo crear staff QA: ${JSON.stringify(staffResponse.data)}`)
  }

  staffId = staffResponse.data.id
  createdStaffIds.push(staffId)

  const cajas = await sqlAdmin<{ id: string }[]>`
    SELECT id
    FROM cajas
    WHERE empresa_id = ${empresaId}
      AND punto_venta_id = ${puntoVentaId}
      AND activa = true
    ORDER BY creado_en ASC
    LIMIT 1
  `

  if (cajas.length === 0) {
    const [createdCaja] = await sqlAdmin`
      INSERT INTO cajas (empresa_id, punto_venta_id, nombre, activa, abierta, monto_inicial_actual, creado_en, actualizado_en)
      VALUES (${empresaId}, ${puntoVentaId}, 'Caja QA Runtime', true, false, 0, NOW(), NOW())
      RETURNING id
    `
    cajaId = createdCaja.id as string
  } else {
    cajaId = cajas[0].id
  }
}

async function resetCaja() {
  await sqlAdmin`
    UPDATE cajas
    SET abierta = false,
        monto_inicial_actual = 0,
        fecha_apertura_actual = NULL,
        actualizado_en = NOW()
    WHERE id = ${cajaId}
  `
}

async function setConfig(config: Record<string, unknown>) {
  const response = await request(
    'PUT',
    '/admin/configuracion-operativa',
    { scope: 'pv', puntoVentaId, config },
    adminToken,
  )

  expect(response.status).toBe(200)
}

async function confirmarVenta(parametros: {
  accionCajaCerrada?: 'abrir' | 'fuera_caja'
  montoInicialApertura?: number
}) {
  const ticket = await request<{ ticketId: string }>('POST', '/ventas/crear-ticket', { puntoVentaId })
  expect(ticket.status).toBe(200)

  const add = await request('POST', `/ventas/ticket/${ticket.data.ticketId}/agregar-item`, {
    tipo: 'servicio',
    itemId: servicioId,
    cantidad: 1,
    precio: 12000,
  })
  expect(add.status).toBe(200)

  return request<{ venta_id?: string; error?: string; mensaje?: string }>('POST', '/ventas/confirmar', {
    staff_id: staffId,
    punto_venta_id: puntoVentaId,
    ticketId: ticket.data.ticketId,
    total: 12000,
    metodo_pago: 'efectivo',
    ...parametros,
  })
}

describe('Runtime P0 - caja y cierre', () => {
  jest.setTimeout(180000)

  beforeAll(async () => {
    const qaAdmin = await ensureQaAdmin()
    adminUserId = qaAdmin.id

    server = spawn('npx', ['tsx', 'src/server.ts'], {
      cwd: process.cwd(),
      shell: true,
      stdio: 'pipe',
      env: {
        ...process.env,
        PORT: String(PORT),
      },
    })

    await waitForServer()

    const login = await request<LoginResponse>('POST', '/admin/login', {
      email: qaAdmin.email,
      password: qaAdmin.password,
    })

    expect(login.status).toBe(200)
    adminToken = login.data.token

    await ensureBaseData(adminToken)
    await resetCaja()
  })

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server?.once('close', () => resolve())
        server?.kill('SIGTERM')
        setTimeout(() => resolve(), 3000)
      })
    }

    const usuariosAudit = [...createdStaffIds, ...(adminUserId ? [adminUserId] : [])]
    if (usuariosAudit.length > 0) {
      await sqlAdmin`DELETE FROM auditoria_eventos WHERE usuario_id = ANY(${usuariosAudit})`
    }

    if (createdItemIds.length > 0) {
      await sqlAdmin`DELETE FROM items WHERE id = ANY(${createdItemIds})`
    }

    if (createdPuntoVentaIds.length > 0) {
      await sqlAdmin`DELETE FROM puntos_venta WHERE id = ANY(${createdPuntoVentaIds})`
    }

    if (adminUserId) {
      await sqlAdmin`DELETE FROM sesiones WHERE usuario_id = ${adminUserId}`
      await sqlAdmin`DELETE FROM usuarios WHERE id = ${adminUserId}`
    }

    await sqlAdmin.end()
  })

  test('manual + abrir con monto inicial aplica monto en caja', async () => {
    await resetCaja()
    await setConfig({
      caja: {
        apertura_modo: 'manual',
        accion_caja_cerrada: 'preguntar',
        permitir_ventas_fuera_caja: true,
      },
    })

    const venta = await confirmarVenta({ accionCajaCerrada: 'abrir', montoInicialApertura: 12000 })
    expect(venta.status).toBe(200)
    expect(venta.data.venta_id).toBeTruthy()

    const [caja] = await sqlAdmin<{ abierta: boolean; monto_inicial_actual: number }[]>`
      SELECT abierta, monto_inicial_actual
      FROM cajas
      WHERE id = ${cajaId}
      LIMIT 1
    `

    expect(caja.abierta).toBe(true)
    expect(Number(caja.monto_inicial_actual)).toBe(12000)
  })

  test('fuera de caja deshabilitado bloquea venta fuera de caja', async () => {
    await resetCaja()
    await setConfig({
      caja: {
        apertura_modo: 'manual',
        accion_caja_cerrada: 'preguntar',
        permitir_ventas_fuera_caja: false,
      },
    })

    const venta = await confirmarVenta({ accionCajaCerrada: 'fuera_caja' })
    expect(venta.status).toBe(409)
    expect(venta.data.error).toBe('FUERA_CAJA_DESHABILITADO')
  })

  test('primera venta sin decision devuelve requerimiento de monto inicial', async () => {
    await resetCaja()
    await setConfig({
      caja: {
        apertura_modo: 'primera_venta',
      },
    })

    const venta = await confirmarVenta({})
    expect(venta.status).toBe(409)
    expect(venta.data.error).toBe('CAJA_REQUIERE_MONTO_INICIAL_PRIMERA_VENTA')
  })

  test('cierre bloquea cuando consumos pendientes y regla no_permitir_cierre', async () => {
    await sqlAdmin`
      UPDATE cajas
      SET abierta = true,
          monto_inicial_actual = 5000,
          fecha_apertura_actual = NOW(),
          actualizado_en = NOW()
      WHERE id = ${cajaId}
    `

    await setConfig({
      consumos: {
        al_cierre_sin_liquidar: 'no_permitir_cierre',
      },
    })

    await sqlAdmin`
      INSERT INTO consumos_staff (
        usuario_id,
        punto_venta_id,
        items,
        total_venta,
        total_costo,
        estado_liquidacion,
        creado_en
      )
      VALUES (
        ${staffId},
        ${puntoVentaId},
        ${JSON.stringify([{ tipo: 'servicio', itemId: servicioId, nombre: 'QA', cantidad: 1, precioVenta: 1000, precioCosto: 0, subtotalVenta: 1000, subtotalCosto: 0 }])}::jsonb,
        1000,
        0,
        'pendiente',
        NOW()
      )
    `

    const cierre = await request<{ error?: string }>(
      'POST',
      '/admin/caja/cerrar',
      {
        cajaId,
        montoReal: 5000,
        observaciones: 'QA cierre bloqueado',
      },
      adminToken,
    )

    expect(cierre.status).toBe(409)
    expect(cierre.data.error).toBe('CIERRE_CONSUMOS_PENDIENTES_BLOQUEADO')

    await sqlAdmin`
      UPDATE consumos_staff
      SET estado_liquidacion = 'liquidado'
      WHERE punto_venta_id = ${puntoVentaId}
        AND usuario_id = ${staffId}
        AND estado_liquidacion = 'pendiente'
    `
  })

  test('staff CRUD: editar, inactivar y resetear pin', async () => {
    const crear = await request<{ id: string; nombreCompleto: string; pin: string }>(
      'POST',
      '/admin/staff',
      { nombreCompleto: `QA Staff CRUD ${Date.now()}`, rolOperativo: 'barbero' },
      adminToken,
    )

    expect(crear.status).toBe(200)
    const targetStaffId = crear.data.id as string
    createdStaffIds.push(targetStaffId)

    const actualizar = await request<{ id: string; nombre: string }>(
      'PUT',
      `/admin/staff/${targetStaffId}`,
      { nombreCompleto: 'QA Staff Editado', rolOperativo: 'encargado' },
      adminToken,
    )
    expect(actualizar.status).toBe(200)

    const inactivar = await request<{ id: string; activo: boolean }>(
      'PUT',
      `/admin/staff/${targetStaffId}/estado`,
      { activo: false },
      adminToken,
    )
    expect(inactivar.status).toBe(200)
    expect(inactivar.data.activo).toBe(false)

    const activar = await request<{ id: string; activo: boolean }>(
      'PUT',
      `/admin/staff/${targetStaffId}/estado`,
      { activo: true },
      adminToken,
    )
    expect(activar.status).toBe(200)
    expect(activar.data.activo).toBe(true)

    const resetPin = await request<{ id: string; pin: string }>(
      'POST',
      `/admin/staff/${targetStaffId}/reset-pin`,
      {},
      adminToken,
    )
    expect(resetPin.status).toBe(200)
    expect(String(resetPin.data.pin || '')).toHaveLength(4)
  })

  test('puntos de venta CRUD y bloqueo por caja abierta', async () => {
    const suffix = Date.now()

    const crearPv = await request<{ id: string; nombre: string }>(
      'POST',
      '/admin/puntos-venta',
      {
        nombre: `QA PV ${suffix}`,
        codigo: `QAPV${suffix}`,
        direccion: 'QA Direccion',
        telefono_contacto: '+54 11 0000-0000',
      },
      adminToken,
    )

    expect(crearPv.status).toBe(200)
    const pvId = crearPv.data.id as string
    createdPuntoVentaIds.push(pvId)

    const actualizarPv = await request<{ id: string; nombre: string }>(
      'PUT',
      `/admin/puntos-venta/${pvId}`,
      {
        nombre: `QA PV Editado ${suffix}`,
        direccion: 'QA Direccion 2',
      },
      adminToken,
    )
    expect(actualizarPv.status).toBe(200)

    const [cajaNuevaPv] = await sqlAdmin<{ id: string }[]>`
      INSERT INTO cajas (empresa_id, punto_venta_id, nombre, activa, abierta, monto_inicial_actual, fecha_apertura_actual, creado_en, actualizado_en)
      VALUES (${empresaId}, ${pvId}, ${'Caja QA PV'}, true, true, 1000, NOW(), NOW(), NOW())
      RETURNING id
    `

    const inactivarBloqueado = await request<{ error?: string }>(
      'PUT',
      `/admin/puntos-venta/${pvId}/estado`,
      { activo: false },
      adminToken,
    )
    expect(inactivarBloqueado.status).toBe(409)
    expect(inactivarBloqueado.data.error).toBe('PUNTO_VENTA_TIENE_CAJA_ABIERTA')

    await sqlAdmin`
      UPDATE cajas
      SET abierta = false,
          actualizado_en = NOW()
      WHERE id = ${cajaNuevaPv.id}
    `

    const inactivarOk = await request<{ activo: boolean }>(
      'PUT',
      `/admin/puntos-venta/${pvId}/estado`,
      { activo: false },
      adminToken,
    )
    expect(inactivarOk.status).toBe(200)
    expect(inactivarOk.data.activo).toBe(false)

    await sqlAdmin`DELETE FROM cajas WHERE id = ${cajaNuevaPv.id}`
  })

  test('catalogo ABM: crear, actualizar e inactivar item', async () => {
    const suffix = Date.now()

    const crearItem = await request<{ id: string; nombre: string }>(
      'POST',
      '/admin/catalogo/items',
      {
        tipo: 'servicio',
        nombre: `QA Servicio ${suffix}`,
        categoria: 'qa',
        precio_venta: 9999,
        orden_ui: 91,
        duracion_min: 30,
      },
      adminToken,
    )
    expect(crearItem.status).toBe(200)
    const itemId = crearItem.data.id as string
    createdItemIds.push(itemId)

    const actualizarItem = await request<{ id: string; nombre: string }>(
      'PUT',
      `/admin/catalogo/items/${itemId}`,
      {
        nombre: `QA Servicio Editado ${suffix}`,
        precio_venta: 11111,
        duracion_min: 45,
      },
      adminToken,
    )
    expect(actualizarItem.status).toBe(200)

    const inactivarItem = await request<{ activo: boolean }>(
      'PUT',
      `/admin/catalogo/items/${itemId}/estado`,
      { activo: false },
      adminToken,
    )
    expect(inactivarItem.status).toBe(200)
    expect(inactivarItem.data.activo).toBe(false)
  })
})
