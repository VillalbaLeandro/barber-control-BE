import { spawn } from 'child_process'
import sql from '../db.js'
import sqlAdmin from '../db-admin.js'
import { authService } from '../services/auth.js'
import { getDefaultEmpresaId } from '../utils/empresa.js'

const BASE_URL = `http://localhost:${process.env.PORT || '3001'}`

type LoginResponse = {
    token: string
    usuario: { id: string; nombre: string; email: string; rol: string }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForServer(maxAttempts = 30): Promise<void> {
    for (let i = 0; i < maxAttempts; i += 1) {
        try {
            const response = await fetch(`${BASE_URL}/`)
            if (response.ok) return
        } catch {
            // continue
        }
        await sleep(1000)
    }
    throw new Error('No se pudo iniciar el servidor para smoke test')
}

async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    token?: string
): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
        const text = await response.text()
        throw new Error(`${method} ${path} -> ${response.status}: ${text}`)
    }

    return (await response.json()) as T
}

async function ensureQaAdmin(): Promise<{ email: string; password: string; empresaId: string }> {
    const password = 'Qa123456!'
    const email = `qa.admin.${Date.now()}@local.dev`
    const username = `qa_admin_${Date.now()}`

    const empresaId = await getDefaultEmpresaId()

    const roles = await sqlAdmin`
        SELECT id
        FROM roles
        ORDER BY CASE WHEN lower(nombre) LIKE '%admin%' THEN 0 ELSE 1 END, nombre
        LIMIT 1
    `
    if (roles.length === 0) {
        throw new Error('No hay roles cargados para crear admin QA')
    }

    const passwordHash = await authService.hashPassword(password)

    await sqlAdmin`
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
            ${'QA Admin'},
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
    `

    return { email, password, empresaId }
}

async function ensureQaService(empresaId: string): Promise<{ id: string; precio_venta: number }> {
    const existing = await sqlAdmin<{ id: string; precio_venta: number }[]>`
        SELECT id, precio_venta
        FROM items
        WHERE tipo = 'servicio'
          AND activo = true
          AND empresa_id = ${empresaId}
        ORDER BY orden_ui NULLS LAST, nombre
        LIMIT 1
    `

    if (existing.length > 0) {
        return { id: existing[0].id, precio_venta: Number(existing[0].precio_venta || 0) }
    }

    const created = await sqlAdmin<{ id: string; precio_venta: number }[]>`
        INSERT INTO items (tipo, nombre, categoria, precio_venta, activo, orden_ui, empresa_id)
        VALUES ('servicio', 'QA Servicio', 'qa', 1000, true, 999, ${empresaId})
        RETURNING id, precio_venta
    `

    return { id: created[0].id, precio_venta: Number(created[0].precio_venta || 0) }
}

async function runSmoke(): Promise<void> {
    const qaAdmin = await ensureQaAdmin()
    const qaService = await ensureQaService(qaAdmin.empresaId)

    const server = spawn('npm', ['run', 'dev'], {
        cwd: process.cwd(),
        shell: true,
        stdio: 'pipe',
    })

    server.stdout.on('data', (chunk) => {
        const text = String(chunk)
        if (text.includes('Server listening')) {
            process.stdout.write(text)
        }
    })

    server.stderr.on('data', (chunk) => {
        process.stderr.write(String(chunk))
    })

    try {
        await waitForServer()

        const login = await request<LoginResponse>('POST', '/admin/login', {
            email: qaAdmin.email,
            password: qaAdmin.password,
        })

        const staffCreate = await request<{ id: string; nombreCompleto: string; pin: string }>(
            'POST',
            '/admin/staff',
            { nombreCompleto: 'QA Staff', rolOperativo: 'barbero' },
            login.token
        )

        const pinValidation = await request<{ id: string; nombre: string }>('POST', '/staff/validar-pin', {
            pin: staffCreate.pin,
        })

        const puntosVenta = await sqlAdmin<{ id: string }[]>`
            SELECT id
            FROM puntos_venta
            WHERE activo = true
              AND empresa_id = ${qaAdmin.empresaId}
            ORDER BY creado_en ASC, id ASC
            LIMIT 5
        `
        if (puntosVenta.length === 0) {
            throw new Error('No hay puntos de venta activos para smoke test')
        }

        const ticket = await request<{ ticketId: string }>('POST', '/ventas/crear-ticket', {
            puntoVentaId: puntosVenta[0].id,
        })

        await request('POST', `/ventas/ticket/${ticket.ticketId}/agregar-item`, {
            tipo: 'servicio',
            itemId: qaService.id,
            cantidad: 1,
            precio: Number(qaService.precio_venta || 0),
        })

        const venta = await request<{ venta_id: string }>('POST', '/ventas/confirmar', {
            staff_id: pinValidation.id,
            punto_venta_id: puntosVenta[0].id,
            ticketId: ticket.ticketId,
            total: Number(qaService.precio_venta || 0),
            metodo_pago: 'efectivo',
        })

        await request('POST', `/admin/transacciones/${venta.venta_id}/anular`, { motivo: 'QA smoke test' }, login.token)

        const auditoria = await request<Array<{ accion: string }>>('GET', '/admin/auditoria?limit=30', undefined, login.token)
        const acciones = new Set(auditoria.map((e) => e.accion))
        const required = ['admin_login', 'staff_creado', 'venta_confirmada', 'venta_anulada']
        const missing = required.filter((r) => !acciones.has(r))
        if (missing.length > 0) {
            throw new Error(`Faltan eventos de auditoria esperados: ${missing.join(', ')}`)
        }

        console.log('SMOKE OK')
        console.log('Admin QA:', qaAdmin.email)
        console.log('Staff QA creado:', staffCreate.nombreCompleto)
        console.log('Venta anulada:', venta.venta_id)
    } finally {
        server.kill('SIGTERM')
        await sleep(1000)
    }
}

runSmoke()
    .then(async () => {
        await sql.end()
        await sqlAdmin.end()
        process.exit(0)
    })
    .catch(async (err) => {
        console.error('SMOKE FAILED:', err)
        await sql.end()
        await sqlAdmin.end()
        process.exit(1)
    })
