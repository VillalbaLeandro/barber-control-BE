import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import sql from '../db-admin.js'
import sqlAdmin from '../db-admin.js'
import { authService } from '../services/auth.js'
import { getDefaultEmpresaId, obtenerEmpresaIdDesdeUsuario } from '../utils/empresa.js'
import { logAuditEvent } from '../utils/audit.js'
import { buildPinFingerprint, generatePin4 } from '../utils/pin.js'
import { DEFAULT_OPERATIVE_CONFIG, deepMerge, getOperativeConfig, normalizeConfigInput } from '../utils/config.js'
import {
    aplicarPoliticaConsumosAlCerrarCaja,
    intentarCierreAutomaticoPuntoVenta,
    procesarCierresAutomaticosPendientesEmpresa,
} from '../utils/operativa-runtime.js'

const loginSchema = z.object({
    email: z.string().email().or(z.string()), // Aceptamos usuario o email
    password: z.string().min(1)
})

const createStaffSchema = z.object({
    nombreCompleto: z.string().min(2),
    rolOperativo: z.enum(['barbero', 'encargado', 'admin']).default('barbero')
})

const cancelarVentaSchema = z.object({
    motivo: z.string().max(500).optional()
})

const actualizarPuntoVentaSchema = z.object({
    direccion: z.string().max(255).optional(),
    telefono_contacto: z.string().max(30).optional(),
})

const operativaScopeSchema = z.object({
    scope: z.enum(['empresa', 'pv']).default('empresa'),
    puntoVentaId: z.string().uuid().optional(),
})

const operativaUpdateSchema = z.object({
    scope: z.enum(['empresa', 'pv']).default('empresa'),
    puntoVentaId: z.string().uuid().optional(),
    config: z.object({
        regional: z.object({
            timezone: z.string().min(3).max(80).optional(),
        }).optional(),
        pin: z.object({
            habilitar_limite_intentos: z.boolean().optional(),
            max_intentos: z.number().int().min(1).max(20).optional(),
            bloqueo_minutos: z.number().int().min(1).max(120).optional(),
            mostrar_contador_intentos: z.boolean().optional(),
        }).optional(),
        caja: z.object({
            cierre_automatico_habilitado: z.boolean().optional(),
            cierre_automatico_hora: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).nullable().optional(),
            apertura_modo: z.enum(['manual', 'primera_venta', 'hora_programada']).optional(),
            apertura_hora: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).nullable().optional(),
            apertura_roles_permitidos: z.array(z.string().uuid()).optional(),
            accion_caja_cerrada: z.enum(['preguntar', 'fuera_caja', 'bloquear']).optional(),
            permitir_ventas_fuera_caja: z.boolean().optional(),
            manejo_fuera_caja_al_cerrar: z.enum(['preguntar', 'incluir', 'excluir']).optional(),
        }).optional(),
        consumos: z.object({
            al_cierre_sin_liquidar: z.enum([
                'pendiente_siguiente_caja',
                'cobro_automatico_venta',
                'cobro_automatico_costo',
                'perdonado',
                'no_permitir_cierre',
            ]).optional(),
        }).optional(),
    })
})

const fueraCajaDecisionSchema = z.object({
    puntoVentaId: z.string().uuid(),
    transaccionIds: z.array(z.string().uuid()).min(1),
    accion: z.enum(['imputar_a_caja_actual', 'marcar_solo_balance', 'dejar_pendiente']),
    motivo: z.string().max(500).optional(),
    abrirCajaSiHaceFalta: z.boolean().optional(),
    montoInicialApertura: z.number().min(0).optional(),
    medioPago: z.enum(['efectivo', 'tarjeta', 'transferencia']).optional(),
})

const adminRoutes: FastifyPluginAsync = async (fastify, opts) => {
    const resolveRoleId = async (empresaId: string, rolOperativo: 'barbero' | 'encargado' | 'admin') => {
        const roleCandidates =
            rolOperativo === 'admin'
                ? ['admin']
                : rolOperativo === 'encargado'
                    ? ['encargado', 'manager', 'barber']
                    : ['barber', 'staff']

        const roles = await sqlAdmin`
            SELECT id, nombre
            FROM roles
            WHERE (empresa_id = ${empresaId} OR empresa_id IS NULL)
            AND nombre = ANY(${roleCandidates})
            ORDER BY
                CASE WHEN empresa_id = ${empresaId} THEN 0 ELSE 1 END,
                CASE WHEN nombre = ${roleCandidates[0]} THEN 0 ELSE 1 END
            LIMIT 1
        `

        if (roles.length > 0) {
            return roles[0].id as string
        }

        const fallback = await sqlAdmin`
            SELECT id FROM roles
            WHERE (empresa_id = ${empresaId} OR empresa_id IS NULL)
            ORDER BY CASE WHEN empresa_id = ${empresaId} THEN 0 ELSE 1 END, nombre ASC
            LIMIT 1
        `

        if (fallback.length === 0) {
            throw new Error('No hay roles configurados para la empresa')
        }

        return fallback[0].id as string
    }

    const generateUniquePin = async (empresaId: string): Promise<string> => {
        for (let i = 0; i < 10000; i += 1) {
            const candidate = generatePin4()
            const fingerprint = buildPinFingerprint(empresaId, candidate)
            const existing = await sqlAdmin`
                SELECT id
                FROM usuarios
                WHERE empresa_id = ${empresaId}
                AND pin_fingerprint = ${fingerprint}
                AND activo = true
                LIMIT 1
            `

            if (existing.length === 0) {
                return candidate
            }
        }

        throw new Error('No se pudo generar un PIN único para la empresa')
    }


    // Login Admin
    fastify.post('/admin/login', async (request, reply) => {
        try {
            const { email, password } = loginSchema.parse(request.body)
            console.log('🔐 Admin login attempt:', email);

            // Buscar usuario por email o nombre de usuario
            const usuarios = await sqlAdmin`
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

            await logAuditEvent({
                empresaId: await obtenerEmpresaIdDesdeUsuario(usuario.id),
                usuarioId: usuario.id,
                accion: 'admin_login',
                entidad: 'sesion_admin',
                metadata: { email },
                request
            })

            const empresaId = await obtenerEmpresaIdDesdeUsuario(usuario.id)
            try {
                await procesarCierresAutomaticosPendientesEmpresa({
                    empresaId,
                    request,
                    motivo: 'admin_login',
                })
            } catch (error) {
                fastify.log.warn({ error }, 'No se pudieron procesar cierres automáticos pendientes en login')
            }

            // Obtener info del rol
            const roles = await sqlAdmin`SELECT nombre FROM roles WHERE id = ${usuario.rol_id}`
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
            const session = await authService.verifySession(token)
            await authService.logout(token)
            const empresaId = session?.usuario_id
                ? await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
                : await getDefaultEmpresaId()
            await logAuditEvent({
                empresaId,
                usuarioId: session?.usuario_id ?? null,
                accion: 'admin_logout',
                entidad: 'sesion_admin',
                metadata: {},
                request
            })
        }
        return { success: true }
    })

    fastify.get('/admin/roles', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            return reply.code(401).send({ error: 'Sesión inválida' })
        }

        const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
        const roles = await sqlAdmin`
            SELECT id, nombre, descripcion, empresa_id
            FROM roles
            WHERE empresa_id = ${empresaId} OR empresa_id IS NULL
            ORDER BY
                CASE WHEN empresa_id = ${empresaId} THEN 0 ELSE 1 END,
                lower(nombre) ASC
        `

        const vistos = new Set<string>()
        const deduplicados = roles.filter((rol) => {
            const clave = String(rol.nombre || '').trim().toLowerCase()
            if (!clave || vistos.has(clave)) return false
            vistos.add(clave)
            return true
        })

        return deduplicados
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

        const puntoVentaHeader = request.headers['x-punto-venta-id']
        if (typeof puntoVentaHeader === 'string' && puntoVentaHeader.length > 0) {
            try {
                await intentarCierreAutomaticoPuntoVenta({
                    puntoVentaId: puntoVentaHeader,
                    request,
                    motivo: 'admin_me',
                })
            } catch (error) {
                fastify.log.warn({ error, puntoVentaId: puntoVentaHeader }, 'No se pudo intentar cierre automático en admin/me')
            }
        }

        console.log('✅ Session valid for:', session.nombre);
        return {
            id: session.usuario_id,
            nombre: session.nombre,
            email: session.correo,
            rol: session.rol_nombre
        }
    })

    fastify.post('/admin/staff', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            return reply.code(401).send({ error: 'Sesión inválida' })
        }

        try {
            const { nombreCompleto, rolOperativo } = createStaffSchema.parse(request.body)
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
            const roleId = await resolveRoleId(empresaId, rolOperativo)

            const pin = await generateUniquePin(empresaId)
            const pinFingerprint = buildPinFingerprint(empresaId, pin)
            const pinHash = await authService.hashPassword(pin)

            const [usuario] = await sqlAdmin`
                INSERT INTO usuarios (
                    nombre_completo,
                    activo,
                    intentos_fallidos,
                    rol_id,
                    empresa_id,
                    password_hash,
                    pin_hash,
                    pin_fingerprint,
                    creado_en,
                    actualizado_en
                )
                VALUES (
                    ${nombreCompleto},
                    true,
                    0,
                    ${roleId},
                    ${empresaId},
                    '',
                    ${pinHash},
                    ${pinFingerprint},
                    NOW(),
                    NOW()
                )
                RETURNING id, nombre_completo
            `

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'staff_creado',
                entidad: 'usuario',
                entidadId: usuario.id,
                metadata: { rolOperativo, nombreCompleto },
                request
            })

            return {
                id: usuario.id,
                nombreCompleto: usuario.nombre_completo,
                rolOperativo,
                pin
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // Admin: Listar puntos de venta para mantenimiento
    fastify.get('/admin/puntos-venta', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            return reply.code(401).send({ error: 'Sesión inválida' })
        }

        try {
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
            const puntosVenta = await sql`
                SELECT id, nombre, codigo, direccion, telefono_contacto, activo, creado_en, actualizado_en
                FROM puntos_venta
                WHERE empresa_id = ${empresaId}
                ORDER BY nombre ASC
            `

            return puntosVenta
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // Admin: Actualizar datos de contacto del punto de venta
    fastify.put('/admin/puntos-venta/:id', async (request, reply) => {
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
            const payload = actualizarPuntoVentaSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const direccion = payload.direccion?.trim() || null
            const telefono = payload.telefono_contacto?.trim() || null

            const updated = await sql`
                UPDATE puntos_venta
                SET direccion = ${direccion},
                    telefono_contacto = ${telefono},
                    actualizado_en = NOW()
                WHERE id = ${id}
                AND empresa_id = ${empresaId}
                RETURNING id, nombre, codigo, direccion, telefono_contacto, activo, actualizado_en
            `

            if (updated.length === 0) {
                return reply.code(404).send({ error: 'Punto de venta no encontrado' })
            }

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'punto_venta_actualizado',
                entidad: 'punto_venta',
                entidadId: id,
                metadata: {
                    direccion,
                    telefono_contacto: telefono,
                },
                request
            })

            return updated[0]
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.get('/admin/configuracion-operativa', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const { scope, puntoVentaId } = operativaScopeSchema.parse(request.query ?? {})
            if (scope === 'pv' && !puntoVentaId) {
                return reply.code(400).send({ error: 'puntoVentaId es requerido para scope pv' })
            }

            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
            const effective = await getOperativeConfig(empresaId, scope === 'pv' ? puntoVentaId : null)

            const wherePv = scope === 'pv' ? puntoVentaId : null
            const current = await sql`
                SELECT id, config, actualizado_en
                FROM configuraciones_operativas
                WHERE empresa_id = ${empresaId}
                AND ${wherePv ? sql`punto_venta_id = ${wherePv}` : sql`punto_venta_id IS NULL`}
                LIMIT 1
            `

            return {
                scope,
                puntoVentaId: wherePv,
                config_guardada: normalizeConfigInput(current[0]?.config),
                config_efectiva: effective,
                defaults: DEFAULT_OPERATIVE_CONFIG,
                actualizado_en: current[0]?.actualizado_en ?? null,
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.put('/admin/configuracion-operativa', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const { scope, puntoVentaId, config } = operativaUpdateSchema.parse(request.body ?? {})
            if (scope === 'pv' && !puntoVentaId) {
                return reply.code(400).send({ error: 'puntoVentaId es requerido para scope pv' })
            }

            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
            const wherePv = scope === 'pv' ? puntoVentaId : null

            const existing = await sql`
                SELECT id, config
                FROM configuraciones_operativas
                WHERE empresa_id = ${empresaId}
                AND ${wherePv ? sql`punto_venta_id = ${wherePv}` : sql`punto_venta_id IS NULL`}
                LIMIT 1
            `

            const merged = deepMerge(normalizeConfigInput(existing[0]?.config), config)

            let row
            if (existing.length > 0) {
                const updated = await sql`
                    UPDATE configuraciones_operativas
                    SET config = ${JSON.stringify(merged)}::jsonb,
                        actualizado_en = NOW()
                    WHERE id = ${existing[0].id}
                    RETURNING id, empresa_id, punto_venta_id, config, actualizado_en
                `
                row = updated[0]
            } else {
                const inserted = await sql`
                    INSERT INTO configuraciones_operativas (empresa_id, punto_venta_id, config)
                    VALUES (${empresaId}, ${wherePv ?? null}, ${JSON.stringify(merged)}::jsonb)
                    RETURNING id, empresa_id, punto_venta_id, config, actualizado_en
                `
                row = inserted[0]
            }

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'configuracion_operativa_actualizada',
                entidad: 'configuracion_operativa',
                entidadId: row.id,
                metadata: {
                    scope,
                    puntoVentaId: wherePv ?? null,
                    patch: config,
                },
                request,
            })

            const effective = await getOperativeConfig(empresaId, wherePv)
            return {
                success: true,
                scope,
                puntoVentaId: wherePv,
                config_guardada: normalizeConfigInput(row.config),
                config_efectiva: effective,
                actualizado_en: row.actualizado_en,
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
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

        const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

        // 1. Ventas de Hoy
        const ventasHoy = await sql`
            SELECT 
                COALESCE(SUM(total), 0) as total,
                COUNT(*) as cantidad
            FROM transacciones 
            WHERE tipo = 'venta_cliente' 
            AND empresa_id = ${empresaId}
            AND DATE(creado_en) = CURRENT_DATE
            AND estado = 'confirmada'
        `

        // 2. Consumos Staff Pendientes
        const consumosPendientes = await sql`
            SELECT 
                COUNT(*) as cantidad,
                COALESCE(SUM(total_venta), 0) as total_estimado
            FROM consumos_staff 
            WHERE punto_venta_id IN (
                SELECT id FROM puntos_venta WHERE empresa_id = ${empresaId}
            )
            AND estado_liquidacion = 'pendiente'
        `

        // 3. Ticket Promedio Hoy
        const ticketPromedio = ventasHoy[0].cantidad > 0
            ? Number(ventasHoy[0].total) / Number(ventasHoy[0].cantidad)
            : 0

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
            WHERE t.empresa_id = ${empresaId}
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
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
            const puntoVentaId = query.puntoVentaId
            const staffId = query.staffId
            const fechaDesde = query.fechaDesde
            const fechaHasta = query.fechaHasta
            const estado = query.estado
            const limit = parseInt(query.limit) || 50
            const offset = parseInt(query.offset) || 0

            const ventas = await sql`
                SELECT 
                    t.id,
                    t.tipo,
                    t.total,
                    t.estado,
                    t.medio_pago_nombre,
                    t.creado_en,
                    t.confirmado_en,
                    t.anulada_en,
                    t.motivo_anulacion,
                    t.fuera_caja,
                    pv.nombre as punto_venta,
                    u.nombre_completo as staff
                FROM transacciones t
                JOIN puntos_venta pv ON t.punto_venta_id = pv.id
                LEFT JOIN usuarios u ON t.usuario_id = u.id
                WHERE t.tipo = 'venta_cliente' 
                AND t.empresa_id = ${empresaId}
                ${estado ? sql`AND t.estado = ${estado}` : sql``}
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
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

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
                    t.anulada_en,
                    t.motivo_anulacion,
                    t.fuera_caja,
                    pv.id as punto_venta_id,
                    pv.nombre as punto_venta_nombre,
                    pv.codigo as punto_venta_codigo,
                    u.id as staff_id,
                    u.nombre_completo as staff_nombre
                FROM transacciones t
                JOIN puntos_venta pv ON t.punto_venta_id = pv.id
                LEFT JOIN usuarios u ON t.usuario_id = u.id
                WHERE t.id = ${id}
                AND t.empresa_id = ${empresaId}
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

    // Admin: Anular venta (libre con log)
    fastify.post('/admin/transacciones/:id/anular', async (request, reply) => {
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
            const { motivo } = cancelarVentaSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const transacciones = await sql`
                SELECT id, estado, total, punto_venta_id
                FROM transacciones
                WHERE id = ${id}
                AND empresa_id = ${empresaId}
                AND tipo = 'venta_cliente'
                LIMIT 1
            `

            if (transacciones.length === 0) {
                return reply.code(404).send({ error: 'Venta no encontrada' })
            }

            const venta = transacciones[0]
            if (venta.estado === 'anulada') {
                return { success: true, alreadyCancelled: true, id }
            }

            await sql`
                UPDATE transacciones
                SET estado = 'anulada',
                    anulada_en = NOW(),
                    anulada_por_admin_id = ${session.usuario_id},
                    motivo_anulacion = ${motivo || null}
                WHERE id = ${id}
            `

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'venta_anulada',
                entidad: 'transaccion',
                entidadId: id,
                metadata: {
                    motivo: motivo || null,
                    total: Number(venta.total),
                    puntoVentaId: venta.punto_venta_id,
                },
                request
            })

            return { success: true, id }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // Admin: Auditoria basica
    fastify.get('/admin/auditoria', async (request, reply) => {
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
            const accion = query.accion
            const fechaDesde = query.fechaDesde
            const fechaHasta = query.fechaHasta
            const limit = parseInt(query.limit) || 100
            const offset = parseInt(query.offset) || 0
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const eventos = await sql`
                SELECT
                    a.id,
                    a.accion,
                    a.entidad,
                    a.entidad_id,
                    a.metadata,
                    a.ip,
                    a.user_agent,
                    a.creado_en,
                    u.nombre_completo as usuario_nombre
                FROM auditoria_eventos a
                LEFT JOIN usuarios u ON a.usuario_id = u.id
                WHERE a.empresa_id = ${empresaId}
                ${accion ? sql`AND a.accion = ${accion}` : sql``}
                ${fechaDesde ? sql`AND DATE(a.creado_en) >= ${fechaDesde}` : sql``}
                ${fechaHasta ? sql`AND DATE(a.creado_en) <= ${fechaHasta}` : sql``}
                ORDER BY a.creado_en DESC
                LIMIT ${Math.min(limit, 500)}
                OFFSET ${offset}
            `

            return eventos
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // Ventas fuera de caja (pendientes y resueltas)
    fastify.get('/admin/caja/fuera-caja', async (request, reply) => {
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
            const estado = query.estado as string | undefined
            const limit = Math.min(parseInt(query.limit) || 100, 300)
            const offset = parseInt(query.offset) || 0

            if (!puntoVentaId) {
                return reply.code(400).send({ error: 'puntoVentaId es requerido' })
            }

            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const whereEstado =
                estado === 'pendiente_caja'
                    ? sql`AND COALESCE(t.fuera_caja_estado, CASE WHEN t.conciliada_en IS NULL THEN 'pendiente_caja' ELSE 'imputada_caja' END) = 'pendiente_caja'`
                    : estado === 'imputada_caja'
                        ? sql`AND COALESCE(t.fuera_caja_estado, CASE WHEN t.conciliada_en IS NULL THEN 'pendiente_caja' ELSE 'imputada_caja' END) = 'imputada_caja'`
                        : estado === 'solo_balance'
                            ? sql`AND COALESCE(t.fuera_caja_estado, CASE WHEN t.conciliada_en IS NULL THEN 'pendiente_caja' ELSE 'imputada_caja' END) = 'solo_balance'`
                            : sql``

            const ventas = await sql`
                SELECT
                    t.id,
                    t.total,
                    t.medio_pago_nombre,
                    t.creado_en,
                    t.confirmado_en,
                    t.conciliada_en,
                    COALESCE(t.fuera_caja_estado, CASE WHEN t.conciliada_en IS NULL THEN 'pendiente_caja' ELSE 'imputada_caja' END) as fuera_caja_estado,
                    u.nombre_completo as staff,
                    pv.nombre as punto_venta
                FROM transacciones t
                JOIN puntos_venta pv ON pv.id = t.punto_venta_id
                LEFT JOIN usuarios u ON u.id = t.usuario_id
                WHERE t.empresa_id = ${empresaId}
                  AND t.punto_venta_id = ${puntoVentaId}
                  AND t.estado = 'confirmada'
                  AND t.fuera_caja = true
                  ${whereEstado}
                ORDER BY t.creado_en DESC
                LIMIT ${limit}
                OFFSET ${offset}
            `

            const kpis = await sql`
                SELECT
                    COALESCE(SUM(CASE WHEN COALESCE(fuera_caja_estado, CASE WHEN conciliada_en IS NULL THEN 'pendiente_caja' ELSE 'imputada_caja' END) = 'pendiente_caja' THEN total ELSE 0 END), 0) as pendiente_total,
                    COALESCE(COUNT(*) FILTER (WHERE COALESCE(fuera_caja_estado, CASE WHEN conciliada_en IS NULL THEN 'pendiente_caja' ELSE 'imputada_caja' END) = 'pendiente_caja'), 0) as pendiente_cantidad,
                    COALESCE(SUM(CASE WHEN COALESCE(fuera_caja_estado, CASE WHEN conciliada_en IS NULL THEN 'pendiente_caja' ELSE 'imputada_caja' END) = 'imputada_caja' AND DATE(COALESCE(conciliada_en, creado_en)) = CURRENT_DATE THEN total ELSE 0 END), 0) as imputada_hoy_total,
                    COALESCE(SUM(CASE WHEN COALESCE(fuera_caja_estado, CASE WHEN conciliada_en IS NULL THEN 'pendiente_caja' ELSE 'imputada_caja' END) = 'solo_balance' AND DATE(COALESCE(conciliada_en, creado_en)) = CURRENT_DATE THEN total ELSE 0 END), 0) as solo_balance_hoy_total,
                    COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(creado_en))) / 60, 0) as antiguedad_max_minutos
                FROM transacciones
                WHERE empresa_id = ${empresaId}
                  AND punto_venta_id = ${puntoVentaId}
                  AND estado = 'confirmada'
                  AND fuera_caja = true
            `

            return {
                ventas,
                kpis: {
                    pendienteCantidad: Number(kpis[0]?.pendiente_cantidad || 0),
                    pendienteTotal: Number(kpis[0]?.pendiente_total || 0),
                    imputadaCajaHoyTotal: Number(kpis[0]?.imputada_hoy_total || 0),
                    soloBalanceHoyTotal: Number(kpis[0]?.solo_balance_hoy_total || 0),
                    antiguedadMaxMinutos: Math.round(Number(kpis[0]?.antiguedad_max_minutos || 0)),
                },
            }
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.post('/admin/caja/fuera-caja/decidir', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            return reply.code(401).send({ error: 'Sesión inválida' })
        }

        try {
            const {
                puntoVentaId,
                transaccionIds,
                accion,
                motivo,
                abrirCajaSiHaceFalta,
                montoInicialApertura,
                medioPago,
            } = fueraCajaDecisionSchema.parse(request.body)
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const transacciones = await sql`
                SELECT id, total, caja_id,
                    COALESCE(fuera_caja_estado, CASE WHEN conciliada_en IS NULL THEN 'pendiente_caja' ELSE 'imputada_caja' END) as fuera_caja_estado
                FROM transacciones
                WHERE empresa_id = ${empresaId}
                  AND punto_venta_id = ${puntoVentaId}
                  AND estado = 'confirmada'
                  AND fuera_caja = true
                  AND id = ANY(${transaccionIds})
            `

            if (transacciones.length === 0) {
                return reply.code(404).send({ error: 'No se encontraron ventas fuera de caja para procesar' })
            }

            const idsPendientes = transacciones
                .filter((t) => t.fuera_caja_estado === 'pendiente_caja')
                .map((t) => t.id as string)

            if (idsPendientes.length === 0) {
                return { success: true, procesadas: 0, mensaje: 'No hay ventas pendientes para aplicar' }
            }

            let cajaAbierta = false
            let cajaIdActiva: string | null = null
            const cajas = await sql`
                SELECT id, abierta
                FROM cajas
                WHERE empresa_id = ${empresaId}
                  AND punto_venta_id = ${puntoVentaId}
                  AND activa = true
                ORDER BY creado_en ASC
                LIMIT 1
            `

            if (cajas.length > 0) {
                cajaIdActiva = cajas[0].id as string
                cajaAbierta = Boolean(cajas[0].abierta)
            }

            if (accion === 'imputar_a_caja_actual') {
                if (!cajaIdActiva) {
                    return reply.code(409).send({ error: 'CAJA_NO_CONFIGURADA', mensaje: 'No hay caja activa para este punto de venta' })
                }

                if (!cajaAbierta) {
                    if (!abrirCajaSiHaceFalta) {
                        return reply.code(409).send({
                            error: 'CAJA_CERRADA_REQUIERE_APERTURA',
                            mensaje: 'La caja está cerrada. Puedes abrirla para imputar estas ventas.',
                        })
                    }

                    await sql`
                        UPDATE cajas
                        SET abierta = true,
                            monto_inicial_actual = ${Number(montoInicialApertura || 0)},
                            fecha_apertura_actual = NOW(),
                            actualizado_en = NOW()
                        WHERE id = ${cajaIdActiva}
                    `
                    cajaAbierta = true
                }

                let medioPagoId: string | null = null
                let medioPagoNombre: string | null = null
                if (medioPago) {
                    const medios = await sql`
                        SELECT id, nombre
                        FROM medios_pago
                        WHERE nombre ILIKE ${medioPago}
                          AND (empresa_id = ${empresaId} OR empresa_id IS NULL)
                        ORDER BY CASE WHEN empresa_id = ${empresaId} THEN 0 ELSE 1 END, creado_en ASC
                        LIMIT 1
                    `
                    medioPagoId = medios[0]?.id || null
                    medioPagoNombre = medios[0]?.nombre || medioPago
                }

                if (medioPagoNombre) {
                    await sql`
                        UPDATE transacciones
                        SET fuera_caja_estado = 'imputada_caja',
                            conciliada_en = NOW(),
                            caja_id = ${cajaIdActiva},
                            medio_pago_id = ${medioPagoId},
                            medio_pago_nombre = ${medioPagoNombre}
                        WHERE id = ANY(${idsPendientes})
                    `
                } else {
                    await sql`
                        UPDATE transacciones
                        SET fuera_caja_estado = 'imputada_caja',
                            conciliada_en = NOW(),
                            caja_id = ${cajaIdActiva}
                        WHERE id = ANY(${idsPendientes})
                    `
                }
            }

            if (accion === 'marcar_solo_balance') {
                await sql`
                    UPDATE transacciones
                    SET fuera_caja_estado = 'solo_balance',
                        conciliada_en = NOW()
                    WHERE id = ANY(${idsPendientes})
                `
            }

            if (accion === 'dejar_pendiente') {
                await sql`
                    UPDATE transacciones
                    SET fuera_caja_estado = 'pendiente_caja',
                        conciliada_en = NULL,
                        conciliada_en_cierre_id = NULL
                    WHERE id = ANY(${idsPendientes})
                `
            }

            const montoTotal = transacciones
                .filter((t) => idsPendientes.includes(t.id as string))
                .reduce((acc, t) => acc + Number(t.total || 0), 0)

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'fuera_caja_decision_masiva',
                entidad: 'transaccion',
                metadata: {
                    puntoVentaId,
                    accion,
                    medioPago: medioPago || null,
                    procesadas: idsPendientes.length,
                    montoTotal,
                    motivo: motivo || null,
                    abrirCajaSiHaceFalta: Boolean(abrirCajaSiHaceFalta),
                },
                request,
            })

            return {
                success: true,
                accion,
                procesadas: idsPendientes.length,
                montoTotal,
                cajaAbierta,
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
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

            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            try {
                await intentarCierreAutomaticoPuntoVenta({
                    puntoVentaId,
                    request,
                    motivo: 'admin_caja_estado',
                })
            } catch (error) {
                fastify.log.warn({ error, puntoVentaId }, 'No se pudo intentar cierre automático al consultar estado de caja')
            }

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

            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

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
                return reply.code(409).send({
                    error: 'CAJA_YA_ABIERTA',
                    mensaje: 'La caja ya está abierta',
                })
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

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'caja_apertura',
                entidad: 'caja',
                entidadId: cajaId,
                metadata: { montoInicial: Number(montoInicial) },
                request
            })

            return { success: true, message: 'Caja abierta exitosamente' }

        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // Cerrar Caja
    fastify.post('/admin/caja/ajustar-monto-inicial', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            return reply.code(401).send({ error: 'Sesión inválida' })
        }

        try {
            const { cajaId, nuevoMontoInicial, motivo } = request.body as any
            if (!cajaId || nuevoMontoInicial === undefined) {
                return reply.code(400).send({ error: 'cajaId y nuevoMontoInicial son requeridos' })
            }

            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const cajas = await sql`
                SELECT id, abierta, monto_inicial_actual
                FROM cajas
                WHERE id = ${cajaId}
                  AND empresa_id = ${empresaId}
                LIMIT 1
            `

            if (cajas.length === 0) {
                return reply.code(404).send({ error: 'Caja no encontrada' })
            }

            const caja = cajas[0]
            if (!caja.abierta) {
                return reply.code(400).send({ error: 'Solo se puede ajustar una caja abierta' })
            }

            await sql`
                UPDATE cajas
                SET monto_inicial_actual = ${Number(nuevoMontoInicial)},
                    actualizado_en = NOW()
                WHERE id = ${cajaId}
            `

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'caja_ajuste_monto_inicial',
                entidad: 'caja',
                entidadId: cajaId,
                metadata: {
                    montoAnterior: Number(caja.monto_inicial_actual),
                    montoNuevo: Number(nuevoMontoInicial),
                    motivo: motivo || null,
                },
                request,
            })

            return { success: true }
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
            const {
                cajaId,
                montoReal,
                observaciones,
                incluirFueraCaja,
                decisionFueraCaja,
                confirmarConsumosPendientes,
            } = request.body as any

            if (!cajaId || montoReal === undefined) {
                return reply.code(400).send({ error: 'cajaId y montoReal son requeridos' })
            }

            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

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

            const configuracion = await getOperativeConfig(empresaId, caja.punto_venta_id)

            const fueraCajaPendientes = await sql`
                SELECT
                    COALESCE(SUM(total), 0) as total,
                    COUNT(*) as cantidad
                FROM transacciones
                WHERE punto_venta_id = ${caja.punto_venta_id}
                AND empresa_id = ${empresaId}
                AND estado = 'confirmada'
                AND fuera_caja = true
                AND (
                    fuera_caja_estado = 'pendiente_caja'
                    OR (fuera_caja_estado IS NULL AND conciliada_en IS NULL)
                )
            `

            const totalFueraCajaPendiente = Number(fueraCajaPendientes[0].total)
            const cantidadFueraCajaPendiente = Number(fueraCajaPendientes[0].cantidad)

            let incluirFueraCajaFinal = false
            if (cantidadFueraCajaPendiente > 0) {
                const politicaFueraCaja = configuracion.caja.manejo_fuera_caja_al_cerrar || 'preguntar'
                if (decisionFueraCaja === 'incluir') {
                    incluirFueraCajaFinal = true
                } else if (decisionFueraCaja === 'excluir') {
                    incluirFueraCajaFinal = false
                } else if (typeof incluirFueraCaja === 'boolean') {
                    incluirFueraCajaFinal = incluirFueraCaja
                } else if (politicaFueraCaja === 'incluir') {
                    incluirFueraCajaFinal = true
                } else if (politicaFueraCaja === 'excluir') {
                    incluirFueraCajaFinal = false
                } else {
                    return reply.code(409).send({
                        error: 'CIERRE_REQUIERE_DECISION_FUERA_CAJA',
                        mensaje: 'Hay ventas fuera de caja pendientes. Indica si deseas incluirlas en este cierre.',
                        cantidadPendiente: cantidadFueraCajaPendiente,
                        totalPendiente: totalFueraCajaPendiente,
                    })
                }
            }

            const consumosPendientes = await sql<{ cantidad: number; total_venta: number }[]>`
                SELECT
                    COUNT(*)::int as cantidad,
                    COALESCE(SUM(total_venta), 0) as total_venta
                FROM consumos_staff
                WHERE punto_venta_id = ${caja.punto_venta_id}
                  AND estado_liquidacion = 'pendiente'
            `

            const cantidadConsumosPendientes = Number(consumosPendientes[0].cantidad)
            const totalConsumosPendientes = Number(consumosPendientes[0].total_venta)
            const reglaConsumos = configuracion.consumos.al_cierre_sin_liquidar

            if (cantidadConsumosPendientes > 0) {
                if (reglaConsumos === 'no_permitir_cierre') {
                    return reply.code(409).send({
                        error: 'CIERRE_CONSUMOS_PENDIENTES_BLOQUEADO',
                        mensaje: 'No se puede cerrar la caja con consumos pendientes del staff. Debes resolverlos primero.',
                        cantidadPendiente: cantidadConsumosPendientes,
                        totalPendiente: totalConsumosPendientes,
                    })
                }

                if (!confirmarConsumosPendientes) {
                    return reply.code(409).send({
                        error: 'CIERRE_REQUIERE_CONFIRMACION_CONSUMOS',
                        mensaje: 'Hay consumos pendientes. Al cerrar se aplicara la accion configurada automaticamente.',
                        cantidadPendiente: cantidadConsumosPendientes,
                        totalPendiente: totalConsumosPendientes,
                        accionConfigurada: reglaConsumos,
                    })
                }
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
                WHERE empresa_id = ${empresaId}
                AND estado = 'confirmada'
                AND (
                    (caja_id = ${cajaId} AND creado_en >= ${caja.fecha_apertura_actual})
                    OR (
                        punto_venta_id = ${caja.punto_venta_id}
                        AND fuera_caja = true
                        AND fuera_caja_estado = 'imputada_caja'
                        AND conciliada_en >= ${caja.fecha_apertura_actual}
                    )
                )
            `

            const montoInicial = Number(caja.monto_inicial_actual)
            const totalEfectivo = Number(totales[0].total_efectivo)
            const montoEsperado = montoInicial + totalEfectivo + (incluirFueraCajaFinal ? totalFueraCajaPendiente : 0)
            const diferencia = Number(montoReal) - montoEsperado
            const fechaOperativa = new Date(caja.fecha_apertura_actual ?? new Date()).toISOString().slice(0, 10)

            // Crear registro de cierre
            const cierre = await sql`
                INSERT INTO cierres_caja (
                    caja_id,
                    punto_venta_id,
                    empresa_id,
                    cerrada_por_admin_id,
                    fecha_operativa,
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
                    observaciones,
                    incluir_fuera_caja,
                    fuera_caja_incluidas,
                    total_fuera_caja_conciliado
                )
                VALUES (
                    ${cajaId},
                    ${caja.punto_venta_id},
                    ${empresaId},
                    ${session.usuario_id},
                    ${fechaOperativa},
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
                    ${Number(totales[0].cantidad_transacciones) + (incluirFueraCajaFinal ? cantidadFueraCajaPendiente : 0)},
                    ${observaciones || null},
                    ${incluirFueraCajaFinal},
                    ${incluirFueraCajaFinal ? cantidadFueraCajaPendiente : 0},
                    ${incluirFueraCajaFinal ? totalFueraCajaPendiente : 0}
                )
                ON CONFLICT (punto_venta_id, caja_id, fecha_operativa)
                DO UPDATE SET
                    empresa_id = EXCLUDED.empresa_id,
                    cerrada_por_admin_id = EXCLUDED.cerrada_por_admin_id,
                    fecha_apertura = EXCLUDED.fecha_apertura,
                    fecha_cierre = EXCLUDED.fecha_cierre,
                    monto_inicial = EXCLUDED.monto_inicial,
                    monto_esperado = EXCLUDED.monto_esperado,
                    monto_real = EXCLUDED.monto_real,
                    diferencia = EXCLUDED.diferencia,
                    total_ventas = EXCLUDED.total_ventas,
                    total_efectivo = EXCLUDED.total_efectivo,
                    total_tarjeta = EXCLUDED.total_tarjeta,
                    total_transferencia = EXCLUDED.total_transferencia,
                    cantidad_transacciones = EXCLUDED.cantidad_transacciones,
                    observaciones = EXCLUDED.observaciones,
                    incluir_fuera_caja = EXCLUDED.incluir_fuera_caja,
                    fuera_caja_incluidas = EXCLUDED.fuera_caja_incluidas,
                    total_fuera_caja_conciliado = EXCLUDED.total_fuera_caja_conciliado
                RETURNING id
            `

            if (incluirFueraCajaFinal && cantidadFueraCajaPendiente > 0) {
                await sql`
                    UPDATE transacciones
                    SET conciliada_en_cierre_id = ${cierre[0].id},
                        conciliada_en = NOW(),
                        fuera_caja_estado = 'imputada_caja'
                    WHERE punto_venta_id = ${caja.punto_venta_id}
                    AND empresa_id = ${empresaId}
                    AND estado = 'confirmada'
                    AND fuera_caja = true
                    AND (
                        fuera_caja_estado = 'pendiente_caja'
                        OR (fuera_caja_estado IS NULL AND conciliada_en IS NULL)
                    )
                `
            }

            const resultadoConsumos = await aplicarPoliticaConsumosAlCerrarCaja({
                empresaId,
                puntoVentaId: caja.punto_venta_id,
                cierreId: cierre[0].id,
                usuarioId: session.usuario_id,
                request,
            })

            // Cerrar caja
            await sql`
                UPDATE cajas 
                SET abierta = false,
                    monto_inicial_actual = 0,
                    fecha_apertura_actual = NULL,
                    actualizado_en = NOW()
                WHERE id = ${cajaId}
            `

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'caja_cierre',
                entidad: 'caja',
                entidadId: cajaId,
                metadata: {
                    cierreId: cierre[0].id,
                    montoReal: Number(montoReal),
                    montoEsperado,
                    diferencia,
                    incluirFueraCaja: incluirFueraCajaFinal,
                    fueraCajaConciliadas: incluirFueraCajaFinal ? cantidadFueraCajaPendiente : 0,
                    consumosAplicados: resultadoConsumos,
                },
                request
            })

            return {
                success: true,
                cierreId: cierre[0].id,
                diferencia: diferencia,
                incluirFueraCaja: incluirFueraCajaFinal,
                fueraCajaConciliadas: incluirFueraCajaFinal ? cantidadFueraCajaPendiente : 0,
                totalFueraCajaConciliado: incluirFueraCajaFinal ? totalFueraCajaPendiente : 0,
                consumosAplicados: resultadoConsumos,
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

            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

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
                WHERE empresa_id = ${empresaId}
                AND estado = 'confirmada'
                AND (
                    (caja_id = ${cajaId} AND creado_en >= ${caja.fecha_apertura_actual})
                    OR (
                        punto_venta_id = ${caja.punto_venta_id}
                        AND fuera_caja = true
                        AND fuera_caja_estado = 'imputada_caja'
                        AND conciliada_en >= ${caja.fecha_apertura_actual}
                    )
                )
            `

            const montoInicial = Number(caja.monto_inicial_actual)
            const totalEfectivo = Number(totales[0].total_efectivo)
            const montoEsperado = montoInicial + totalEfectivo

            const fueraCajaPendientes = await sql`
                SELECT
                    COALESCE(SUM(total), 0) as total,
                    COUNT(*) as cantidad
                FROM transacciones
                WHERE punto_venta_id = ${caja.punto_venta_id}
                AND empresa_id = ${empresaId}
                AND estado = 'confirmada'
                AND fuera_caja = true
                AND (
                    fuera_caja_estado = 'pendiente_caja'
                    OR (fuera_caja_estado IS NULL AND conciliada_en IS NULL)
                )
            `

            return {
                abierta: true,
                montoInicial: montoInicial,
                totalVentas: Number(totales[0].total_ventas),
                cantidadTransacciones: Number(totales[0].cantidad_transacciones),
                totalEfectivo: totalEfectivo,
                totalTarjeta: Number(totales[0].total_tarjeta),
                totalTransferencia: Number(totales[0].total_transferencia),
                montoEsperado: montoEsperado,
                fueraCajaPendientesCantidad: Number(fueraCajaPendientes[0].cantidad),
                fueraCajaPendientesTotal: Number(fueraCajaPendientes[0].total)
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

            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            try {
                await procesarCierresAutomaticosPendientesEmpresa({
                    empresaId,
                    request,
                    motivo: 'admin_cierres_listado',
                })
            } catch (error) {
                fastify.log.warn({ error, empresaId }, 'No se pudieron procesar cierres automáticos pendientes antes de listar cierres')
            }

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

            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

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
