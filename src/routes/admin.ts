import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import sql from '../db.js'
import { authService } from '../services/auth.js'
import { getDefaultEmpresaId } from '../utils/empresa.js'

const loginSchema = z.object({
    email: z.string().email().or(z.string()), // Aceptamos usuario o email
    password: z.string().min(1)
})

const adminRoutes: FastifyPluginAsync = async (fastify, opts) => {

    // Login Admin
    fastify.post('/admin/login', async (request, reply) => {
        try {
            const { email, password } = loginSchema.parse(request.body)
            console.log('🔐 Admin login attempt:', email);

            // Buscar usuario por email o nombre de usuario
            const usuarios = await sql`
                SELECT id, nombre_completo as nombre, correo, password_hash, rol_id, activo 
                FROM usuarios 
                WHERE correo = ${email} OR usuario = ${email}
            `

            if (usuarios.length === 0) {
                console.log('❌ Usuario no encontrado:', email);
                return reply.code(401).send({ error: 'Credenciales inválidas' })
            }

            const usuario = usuarios[0]
            console.log('✅ Usuario encontrado:', usuario.nombre);

            if (!usuario.activo) {
                console.log('❌ Usuario desactivado');
                return reply.code(403).send({ error: 'Usuario desactivado' })
            }

            // Verificar contraseña
            console.log('🔑 Verificando password...');
            const isValid = await authService.verifyPassword(password, usuario.password_hash)
            if (!isValid) {
                console.log('❌ Password inválido');
                return reply.code(401).send({ error: 'Credenciales inválidas' })
            }
            console.log('✅ Password válido');

            // Crear sesión
            console.log('📝 Creando sesión...');
            const session = await authService.createSession(usuario.id)
            console.log('✅ Sesión creada:', session.token);

            // Obtener info del rol
            const roles = await sql`SELECT nombre FROM roles WHERE id = ${usuario.rol_id}`
            const rolNombre = roles.length > 0 ? roles[0].nombre : 'unknown'

            return {
                token: session.token,
                usuario: {
                    id: usuario.id,
                    nombre: usuario.nombre,
                    email: usuario.correo,
                    rol: rolNombre
                },
                expiraEn: session.expiraEn
            }

        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // Logout
    fastify.post('/admin/logout', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (token) {
            await authService.logout(token)
        }
        return { success: true }
    })

    // Verificar Sesión (Me)
    fastify.get('/admin/me', async (request, reply) => {
        console.log('🔍 /admin/me - Headers:', request.headers.authorization);
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            console.log('❌ No token provided');
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            console.log('❌ Invalid token');
            return reply.code(401).send({ error: 'No autorizado' })
        }

        console.log('✅ Session valid for:', session.nombre);
        return {
            id: session.usuario_id,
            nombre: session.nombre,
            email: session.correo,
            rol: session.rol_nombre
        }
    })
    // Dashboard Stats
    fastify.get('/admin/dashboard', async (request, reply) => {
        console.log('🔍 /admin/dashboard - Headers:', request.headers.authorization);
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            console.log('❌ No token provided');
            return reply.code(401).send({ error: 'No autorizado' })
        }
        const session = await authService.verifySession(token)
        if (!session) {
            console.log('❌ Invalid session');
            return reply.code(401).send({ error: 'Sesión inválida' })
        }
        console.log('✅ Session valid for dashboard');

        // 1. Ventas de Hoy
        const ventasHoy = await sql`
            SELECT 
                COALESCE(SUM(total), 0) as total,
                COUNT(*) as cantidad
            FROM transacciones 
            WHERE tipo = 'venta_cliente' 
            AND DATE(creado_en) = CURRENT_DATE
            AND estado = 'confirmada'
        `

        // 2. Consumos Staff Pendientes
        const consumosPendientes = await sql`
            SELECT 
                COUNT(*) as cantidad,
                COALESCE(SUM(total_venta), 0) as total_estimado
            FROM consumos_staff 
            WHERE estado_liquidacion = 'pendiente'
        `

        // 3. Ticket Promedio Hoy
        const ticketPromedio = ventasHoy[0].cantidad > 0
            ? Number(ventasHoy[0].total) / Number(ventasHoy[0].cantidad)
            : 0

        // 4. Últimas 5 Transacciones
        const ultimasTransacciones = await sql`
            SELECT t.id, t.tipo, t.total, t.creado_en, pv.nombre as punto_venta, u.nombre_completo as staff
            FROM transacciones t
            JOIN puntos_venta pv ON t.punto_venta_id = pv.id
            LEFT JOIN usuarios u ON t.usuario_id = u.id
            ORDER BY t.creado_en DESC
            LIMIT 5
        `
        // Corrección query ultimasTransacciones: staff_id en transacciones es FK a staff(id)
        // La tabla staff tiene campo nombre_completo

        const ultimas = await sql`
            SELECT 
                t.id, 
                t.tipo, 
                t.total, 
                t.creado_en, 
                pv.nombre as punto_venta, 
                u.nombre_completo as staff
            FROM transacciones t
            JOIN puntos_venta pv ON t.punto_venta_id = pv.id
            JOIN usuarios u ON t.usuario_id = u.id
            ORDER BY t.creado_en DESC
            LIMIT 5
        `

        return {
            ventasHoy: {
                total: Number(ventasHoy[0].total),
                cantidad: Number(ventasHoy[0].cantidad)
            },
            consumosPendientes: {
                cantidad: Number(consumosPendientes[0].cantidad),
                total: Number(consumosPendientes[0].total_estimado)
            },
            ticketPromedio: Math.round(ticketPromedio),
            ultimas: ultimas
        }
    })

    // Admin: Listar Ventas
    fastify.get('/admin/ventas', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            return reply.code(401).send({ error: 'Sesión inválida' })
        }

        try {
            const query = request.query as any
            const puntoVentaId = query.puntoVentaId
            const staffId = query.staffId
            const fechaDesde = query.fechaDesde
            const fechaHasta = query.fechaHasta
            const limit = parseInt(query.limit) || 50
            const offset = parseInt(query.offset) || 0

            let whereConditions = [`t.tipo = 'venta_cliente'`, `t.estado = 'confirmada'`]

            const ventas = await sql`
                SELECT 
                    t.id,
                    t.tipo,
                    t.total,
                    t.medio_pago_nombre,
                    t.creado_en,
                    t.confirmado_en,
                    pv.nombre as punto_venta,
                    u.nombre_completo as staff
                FROM transacciones t
                JOIN puntos_venta pv ON t.punto_venta_id = pv.id
                LEFT JOIN usuarios u ON t.usuario_id = u.id
                WHERE t.tipo = 'venta_cliente' 
                AND t.estado = 'confirmada'
                ${puntoVentaId ? sql`AND t.punto_venta_id = ${puntoVentaId}` : sql``}
                ${staffId ? sql`AND t.usuario_id = ${staffId}` : sql``}
                ${fechaDesde ? sql`AND DATE(t.creado_en) >= ${fechaDesde}` : sql``}
                ${fechaHasta ? sql`AND DATE(t.creado_en) <= ${fechaHasta}` : sql``}
                ORDER BY t.creado_en DESC
                LIMIT ${limit}
                OFFSET ${offset}
            `

            return ventas

        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // Admin: Detalle de Transacción
    fastify.get('/admin/transacciones/:id', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            return reply.code(401).send({ error: 'Sesión inválida' })
        }

        try {
            const { id } = request.params as { id: string }

            const transacciones = await sql`
                SELECT 
                    t.id,
                    t.tipo,
                    t.subtotal,
                    t.total,
                    t.medio_pago_nombre,
                    t.estado,
                    t.creado_en,
                    t.confirmado_en,
                    pv.id as punto_venta_id,
                    pv.nombre as punto_venta_nombre,
                    pv.codigo as punto_venta_codigo,
                    u.id as staff_id,
                    u.nombre_completo as staff_nombre
                FROM transacciones t
                JOIN puntos_venta pv ON t.punto_venta_id = pv.id
                LEFT JOIN usuarios u ON t.usuario_id = u.id
                WHERE t.id = ${id}
            `

            if (transacciones.length === 0) {
                return reply.code(404).send({ error: 'Transacción no encontrada' })
            }

            const transaccion = transacciones[0]

            const detalles = await sql`
                SELECT 
                    td.id,
                    td.tipo_item,
                    td.nombre_item,
                    td.cantidad,
                    td.precio_unitario_aplicado,
                    td.total_linea,
                    s.nombre as servicio_nombre,
                    p.nombre as producto_nombre
                FROM transaccion_detalles td
                LEFT JOIN servicios s ON td.servicio_id = s.id
                LEFT JOIN productos p ON td.producto_id = p.id
                WHERE td.transaccion_id = ${id}
                ORDER BY td.id
            `

            return {
                ...transaccion,
                items: detalles
            }

        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // ============================================================================
    // ENDPOINTS DE CAJA
    // ============================================================================

    // Estado de Caja
    fastify.get('/admin/caja/estado', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            return reply.code(401).send({ error: 'Sesión inválida' })
        }

        try {
            const query = request.query as any
            const puntoVentaId = query.puntoVentaId

            if (!puntoVentaId) {
                return reply.code(400).send({ error: 'puntoVentaId es requerido' })
            }

            const empresaId = await getDefaultEmpresaId();

            // Buscar caja activa del punto de venta
            const cajas = await sql`
                SELECT * FROM cajas 
                WHERE punto_venta_id = ${puntoVentaId} 
                AND empresa_id = ${empresaId}
                AND activa = true 
                LIMIT 1
            `

            if (cajas.length === 0) {
                return reply.code(404).send({ error: 'No hay caja activa para este punto de venta' })
            }

            const caja = cajas[0]

            return {
                id: caja.id,
                nombre: caja.nombre,
                abierta: caja.abierta,
                montoInicial: caja.monto_inicial_actual,
                fechaApertura: caja.fecha_apertura_actual
            }

        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // Abrir Caja
    fastify.post('/admin/caja/abrir', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            return reply.code(401).send({ error: 'Sesión inválida' })
        }

        try {
            const { cajaId, montoInicial } = request.body as any

            if (!cajaId || montoInicial === undefined) {
                return reply.code(400).send({ error: 'cajaId y montoInicial son requeridos' })
            }

            const empresaId = await getDefaultEmpresaId();

            // Verificar que la caja no esté ya abierta
            const cajas = await sql`
                SELECT * FROM cajas 
                WHERE id = ${cajaId} 
                AND empresa_id = ${empresaId}
            `
            if (cajas.length === 0) {
                return reply.code(404).send({ error: 'Caja no encontrada' })
            }

            if (cajas[0].abierta) {
                return reply.code(400).send({ error: 'La caja ya está abierta' })
            }

            // Abrir caja
            await sql`
                UPDATE cajas 
                SET abierta = true,
                    monto_inicial_actual = ${montoInicial},
                    fecha_apertura_actual = NOW(),
                    actualizado_en = NOW()
                WHERE id = ${cajaId}
            `

            return { success: true, message: 'Caja abierta exitosamente' }

        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // Cerrar Caja
    fastify.post('/admin/caja/cerrar', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            return reply.code(401).send({ error: 'Sesión inválida' })
        }

        try {
            const { cajaId, montoReal, observaciones } = request.body as any

            if (!cajaId || montoReal === undefined) {
                return reply.code(400).send({ error: 'cajaId y montoReal son requeridos' })
            }

            const empresaId = await getDefaultEmpresaId();

            // Verificar que la caja esté abierta
            const cajas = await sql`
                SELECT * FROM cajas 
                WHERE id = ${cajaId} 
                AND empresa_id = ${empresaId}
            `
            if (cajas.length === 0) {
                return reply.code(404).send({ error: 'Caja no encontrada' })
            }

            const caja = cajas[0]
            if (!caja.abierta) {
                return reply.code(400).send({ error: 'La caja no está abierta' })
            }

            // Calcular totales del día
            const totales = await sql`
                SELECT 
                    COALESCE(SUM(total), 0) as total_ventas,
                    COUNT(*) as cantidad_transacciones,
                    COALESCE(SUM(CASE WHEN medio_pago_nombre ILIKE '%efectivo%' THEN total ELSE 0 END), 0) as total_efectivo,
                    COALESCE(SUM(CASE WHEN medio_pago_nombre ILIKE '%tarjeta%' THEN total ELSE 0 END), 0) as total_tarjeta,
                    COALESCE(SUM(CASE WHEN medio_pago_nombre ILIKE '%transferencia%' THEN total ELSE 0 END), 0) as total_transferencia
                FROM transacciones
                WHERE caja_id = ${cajaId}
                AND empresa_id = ${empresaId}
                AND creado_en >= ${caja.fecha_apertura_actual}
                AND estado = 'confirmada'
            `

            const montoInicial = Number(caja.monto_inicial_actual)
            const totalEfectivo = Number(totales[0].total_efectivo)
            const montoEsperado = montoInicial + totalEfectivo
            const diferencia = Number(montoReal) - montoEsperado

            // Crear registro de cierre
            const cierre = await sql`
                INSERT INTO cierres_caja (
                    caja_id,
                    punto_venta_id,
                    empresa_id,
                    cerrada_por_admin_id,
                    fecha_apertura,
                    fecha_cierre,
                    monto_inicial,
                    monto_esperado,
                    monto_real,
                    diferencia,
                    total_ventas,
                    total_efectivo,
                    total_tarjeta,
                    total_transferencia,
                    cantidad_transacciones,
                    observaciones
                )
                VALUES (
                    ${cajaId},
                    ${caja.punto_venta_id},
                    ${empresaId},
                    ${session.usuario_id},
                    ${caja.fecha_apertura_actual},
                    NOW(),
                    ${montoInicial},
                    ${montoEsperado},
                    ${montoReal},
                    ${diferencia},
                    ${totales[0].total_ventas},
                    ${totalEfectivo},
                    ${totales[0].total_tarjeta},
                    ${totales[0].total_transferencia},
                    ${totales[0].cantidad_transacciones},
                    ${observaciones || null}
                )
                RETURNING id
            `

            // Cerrar caja
            await sql`
                UPDATE cajas 
                SET abierta = false,
                    monto_inicial_actual = 0,
                    fecha_apertura_actual = NULL,
                    actualizado_en = NOW()
                WHERE id = ${cajaId}
            `

            return {
                success: true,
                cierreId: cierre[0].id,
                diferencia: diferencia
            }

        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // Resumen del Día
    fastify.get('/admin/caja/resumen-dia', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            return reply.code(401).send({ error: 'Sesión inválida' })
        }

        try {
            const query = request.query as any
            const cajaId = query.cajaId

            if (!cajaId) {
                return reply.code(400).send({ error: 'cajaId es requerido' })
            }

            const empresaId = await getDefaultEmpresaId();

            const cajas = await sql`
                SELECT * FROM cajas 
                WHERE id = ${cajaId} 
                AND empresa_id = ${empresaId}
            `
            if (cajas.length === 0) {
                return reply.code(404).send({ error: 'Caja no encontrada' })
            }

            const caja = cajas[0]

            if (!caja.abierta) {
                return { abierta: false }
            }

            // Obtener transacciones del día
            const totales = await sql`
                SELECT 
                    COALESCE(SUM(total), 0) as total_ventas,
                    COUNT(*) as cantidad_transacciones,
                    COALESCE(SUM(CASE WHEN medio_pago_nombre ILIKE '%efectivo%' THEN total ELSE 0 END), 0) as total_efectivo,
                    COALESCE(SUM(CASE WHEN medio_pago_nombre ILIKE '%tarjeta%' THEN total ELSE 0 END), 0) as total_tarjeta,
                    COALESCE(SUM(CASE WHEN medio_pago_nombre ILIKE '%transferencia%' THEN total ELSE 0 END), 0) as total_transferencia
                FROM transacciones
                WHERE caja_id = ${cajaId}
                AND empresa_id = ${empresaId}
                AND creado_en >= ${caja.fecha_apertura_actual}
                AND estado = 'confirmada'
            `

            const montoInicial = Number(caja.monto_inicial_actual)
            const totalEfectivo = Number(totales[0].total_efectivo)
            const montoEsperado = montoInicial + totalEfectivo

            return {
                abierta: true,
                montoInicial: montoInicial,
                totalVentas: Number(totales[0].total_ventas),
                cantidadTransacciones: Number(totales[0].cantidad_transacciones),
                totalEfectivo: totalEfectivo,
                totalTarjeta: Number(totales[0].total_tarjeta),
                totalTransferencia: Number(totales[0].total_transferencia),
                montoEsperado: montoEsperado
            }

        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // ============================================================================
    // ENDPOINTS DE CIERRES
    // ============================================================================

    // Listar Cierres
    fastify.get('/admin/cierres', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            return reply.code(401).send({ error: 'Sesión inválida' })
        }

        try {
            const query = request.query as any
            const fechaDesde = query.fechaDesde
            const fechaHasta = query.fechaHasta
            const limit = parseInt(query.limit) || 50
            const offset = parseInt(query.offset) || 0

            const empresaId = await getDefaultEmpresaId();

            const cierres = await sql`
                SELECT 
                    c.id,
                    c.fecha_apertura,
                    c.fecha_cierre,
                    c.monto_inicial,
                    c.monto_esperado,
                    c.monto_real,
                    c.diferencia,
                    c.total_ventas,
                    c.cantidad_transacciones,
                    caja.nombre as caja_nombre,
                    pv.nombre as punto_venta_nombre,
                    u.nombre_completo as cerrada_por
                FROM cierres_caja c
                JOIN cajas caja ON c.caja_id = caja.id
                JOIN puntos_venta pv ON caja.punto_venta_id = pv.id
                LEFT JOIN usuarios u ON c.cerrada_por_admin_id = u.id
                WHERE c.empresa_id = ${empresaId}
                ${fechaDesde ? sql`AND DATE(c.fecha_cierre) >= ${fechaDesde}` : sql``}
                ${fechaHasta ? sql`AND DATE(c.fecha_cierre) <= ${fechaHasta}` : sql``}
                ORDER BY c.fecha_cierre DESC
                LIMIT ${limit}
                OFFSET ${offset}
            `

            return cierres

        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // Detalle de Cierre
    fastify.get('/admin/cierres/:id', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            return reply.code(401).send({ error: 'Sesión inválida' })
        }

        try {
            const { id } = request.params as { id: string }

            const empresaId = await getDefaultEmpresaId();

            const cierres = await sql`
                SELECT 
                    c.*,
                    caja.nombre as caja_nombre,
                    pv.nombre as punto_venta_nombre,
                    pv.codigo as punto_venta_codigo,
                    u.nombre_completo as cerrada_por
                FROM cierres_caja c
                JOIN cajas caja ON c.caja_id = caja.id
                JOIN puntos_venta pv ON caja.punto_venta_id = pv.id
                LEFT JOIN usuarios u ON c.cerrada_por_admin_id = u.id
                WHERE c.id = ${id}
                AND c.empresa_id = ${empresaId}
            `

            if (cierres.length === 0) {
                return reply.code(404).send({ error: 'Cierre no encontrado' })
            }

            return cierres[0]

        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })
}

export default adminRoutes
