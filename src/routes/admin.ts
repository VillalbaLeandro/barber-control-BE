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
import { reintegrarStockPorAnulacion } from '../utils/stock.js'

const loginSchema = z.object({
    email: z.string().email().or(z.string()), // Aceptamos usuario o email
    password: z.string().min(1)
})

const createStaffSchema = z.object({
    nombreCompleto: z.string().min(2),
    rolOperativo: z.enum(['barbero', 'encargado', 'admin']).default('barbero')
})

const updateStaffSchema = z.object({
    nombreCompleto: z.string().min(2).max(120).optional(),
    rolOperativo: z.enum(['barbero', 'encargado', 'admin']).optional(),
})

const changeStaffStatusSchema = z.object({
    activo: z.boolean(),
})

const cancelarVentaSchema = z.object({
    motivo: z.string().max(500).optional()
})

const crearPuntoVentaSchema = z.object({
    nombre: z.string().min(2).max(120),
    codigo: z.string().min(2).max(40).optional(),
    direccion: z.string().max(255).optional(),
    telefono_contacto: z.string().max(30).optional(),
})

const actualizarPuntoVentaSchema = z.object({
    nombre: z.string().min(2).max(120).optional(),
    codigo: z.string().min(2).max(40).optional(),
    direccion: z.string().max(255).optional(),
    telefono_contacto: z.string().max(30).optional(),
})

const estadoPuntoVentaSchema = z.object({
    activo: z.boolean(),
})

const categoriaDefaultsSchema = z.object({
    maneja_stock: z.boolean().optional(),
    usa_costo: z.boolean().optional(),
    requiere_duracion: z.boolean().optional(),
    permite_consumo_staff: z.boolean().optional(),
    tipo_cantidad: z.enum(['entero', 'decimal']).optional(),
})

const categoriasListadoSchema = z.object({
    puntoVentaId: z.string().uuid().optional(),
    incluirInactivas: z.enum(['true', 'false']).optional(),
})

const crearCategoriaSchema = z.object({
    nombre: z.string().min(2).max(120),
    ordenUiBase: z.number().int().min(0).optional(),
    defaultsConfig: categoriaDefaultsSchema.optional(),
    scope: z.enum(['solo_pv', 'pvs', 'todos_pv']).default('todos_pv'),
    puntoVentaId: z.string().uuid().optional(),
    puntoVentaIds: z.array(z.string().uuid()).optional(),
})

const actualizarCategoriaSchema = z.object({
    nombre: z.string().min(2).max(120).optional(),
    ordenUiBase: z.number().int().min(0).optional(),
    defaultsConfig: categoriaDefaultsSchema.optional(),
})

const estadoCategoriaSchema = z.object({
    activaBase: z.boolean(),
})

const categoriaPvUpdateSchema = z.object({
    puntoVentaId: z.string().uuid(),
    activaEnPv: z.boolean().optional(),
    ordenUiPv: z.number().int().min(0).nullable().optional(),
})

const categoriaAplicarSchema = z.object({
    scope: z.enum(['todos_pv', 'pvs']),
    puntoVentaIds: z.array(z.string().uuid()).optional(),
    activaEnPv: z.boolean().default(true),
})

const catalogoScopeSchema = z.object({
    activo: z.enum(['true', 'false']).optional(),
    puntoVentaId: z.string().uuid().optional(),
    categoriaId: z.string().uuid().optional(),
})

const crearCatalogoItemSchema = z.object({
    nombre: z.string().min(2).max(120),
    categoria: z.string().max(120).optional(),
    categoriaId: z.string().uuid().nullable().optional(),
    precio_venta: z.number().min(0),
    activo: z.boolean().optional(),
    orden_ui: z.number().int().min(0).optional(),
    costo: z.number().min(0).optional(),
    maneja_stock: z.boolean().optional(),
    stock_actual: z.number().min(0).optional(),
    stock_minimo: z.number().min(0).optional(),
    permite_consumo_staff: z.boolean().optional(),
    tipo_cantidad: z.enum(['entero', 'decimal']).optional(),
    duracion_min: z.number().int().min(1).max(600).nullable().optional(),
    scope: z.enum(['solo_pv', 'todos_pv_activos']).default('todos_pv_activos'),
    puntoVentaId: z.string().uuid().optional(),
})

const actualizarCatalogoItemSchema = crearCatalogoItemSchema.partial().extend({
    nombre: z.string().min(2).max(120).optional(),
})

const estadoCatalogoItemSchema = z.object({
    activo: z.boolean(),
})

const catalogoPvOpcionesSchema = z.object({
    excludePuntoVentaId: z.string().uuid().optional(),
})

const inventarioAjusteSchema = z.object({
    itemId: z.string().uuid(),
    puntoVentaId: z.string().uuid(),
    nuevoStock: z.number().min(0),
    motivo: z.string().min(3).max(300),
})

const inventarioCompraSchema = z.object({
    itemId: z.string().uuid(),
    puntoVentaId: z.string().uuid(),
    cantidad: z.number().positive(),
    costoUnitario: z.number().min(0).optional(),
    costoTotal: z.number().min(0).optional(),
    proveedor: z.string().max(160).optional(),
    referencia: z.string().max(160).optional(),
    descripcion: z.string().max(300).optional(),
    imputaCaja: z.boolean().default(true),
})

const inventarioCompraConAltaPvSchema = z.object({
    itemId: z.string().uuid(),
    puntoVentaDestinoId: z.string().uuid(),
    cantidad: z.number().positive(),
    costoUnitario: z.number().min(0).optional(),
    costoTotal: z.number().min(0).optional(),
    proveedor: z.string().max(160).optional(),
    referencia: z.string().max(160).optional(),
    descripcion: z.string().max(300).optional(),
    imputaCaja: z.boolean().default(true),
    modoConfiguracion: z.enum(['copiar', 'manual']),
    puntoVentaOrigenId: z.string().uuid().optional(),
    configuracionManual: z.object({
        precioVentaPv: z.number().min(0),
        costo: z.number().min(0),
        stockMinimoPv: z.number().min(0).default(0),
        permiteConsumoStaff: z.boolean().default(true),
        ordenUiPv: z.number().int().min(0).default(0),
    }).optional(),
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

    const assertPuntoVentaEmpresa = async (empresaId: string, puntoVentaId: string) => {
        const rows = await sqlAdmin`
            SELECT id
            FROM puntos_venta
            WHERE id = ${puntoVentaId}
              AND empresa_id = ${empresaId}
            LIMIT 1
        `

        if (rows.length === 0) {
            const error = new Error('El punto de venta no pertenece a la empresa del usuario')
            ;(error as any).codigo = 'PUNTO_VENTA_FUERA_EMPRESA'
            throw error
        }
    }

    const normalizeCategoriaNombre = (value: string) => value.trim().replace(/\s+/g, ' ')
    const categoriaNombreNormalizado = (value: string) => normalizeCategoriaNombre(value).toLowerCase()

    const assertCategoriaEmpresa = async (empresaId: string, categoriaId: string) => {
        const rows = await sqlAdmin`
            SELECT id
            FROM categorias_catalogo
            WHERE id = ${categoriaId}
              AND empresa_id = ${empresaId}
            LIMIT 1
        `

        if (rows.length === 0) {
            const error = new Error('La categoria no pertenece a la empresa del usuario')
            ;(error as any).codigo = 'CATEGORIA_FUERA_EMPRESA'
            throw error
        }
    }

    const getCategoriaDefaults = async (empresaId: string, categoriaId: string | null | undefined) => {
        if (!categoriaId) return null

        const rows = await sqlAdmin`
            SELECT id, defaults_config
            FROM categorias_catalogo
            WHERE id = ${categoriaId}
              AND empresa_id = ${empresaId}
            LIMIT 1
        `

        if (rows.length === 0) return null

        return {
            id: rows[0].id as string,
            defaultsConfig: (rows[0].defaults_config ?? {}) as Record<string, unknown>,
        }
    }

    const resolveCategoriaIdFromInput = async (
        tx: any,
        empresaId: string,
        categoriaIdInput?: string | null,
        categoriaTextoInput?: string | null,
    ): Promise<string | null> => {
        if (categoriaIdInput === null) return null

        if (categoriaIdInput) {
            const rows = await tx`
                SELECT id
                FROM categorias_catalogo
                WHERE id = ${categoriaIdInput}
                  AND empresa_id = ${empresaId}
                LIMIT 1
            `
            if (rows.length === 0) {
                const error = new Error('La categoria no pertenece a la empresa del usuario')
                ;(error as any).codigo = 'CATEGORIA_FUERA_EMPRESA'
                throw error
            }
            return rows[0].id as string
        }

        const categoriaTexto = categoriaTextoInput ? normalizeCategoriaNombre(categoriaTextoInput) : ''
        if (!categoriaTexto) return null

        const nombreNormalizado = categoriaNombreNormalizado(categoriaTexto)
        const existentes = await tx`
            SELECT id
            FROM categorias_catalogo
            WHERE empresa_id = ${empresaId}
              AND nombre_normalizado = ${nombreNormalizado}
            LIMIT 1
        `

        if (existentes.length > 0) {
            return existentes[0].id as string
        }

        const [creada] = await tx`
            INSERT INTO categorias_catalogo (
                empresa_id,
                nombre,
                nombre_normalizado,
                activa_base,
                orden_ui_base,
                defaults_config
            )
            VALUES (
                ${empresaId},
                ${categoriaTexto},
                ${nombreNormalizado},
                true,
                0,
                '{}'::jsonb
            )
            RETURNING id
        `

        return creada.id as string
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
            if ((err as any)?.codigo === 'PUNTO_VENTA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'PUNTO_VENTA_FUERA_EMPRESA' })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.get('/admin/staff', async (request, reply) => {
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
            const staff = await sqlAdmin`
                SELECT
                    u.id,
                    u.nombre_completo as nombre,
                    COALESCE(lower(r.nombre), 'barbero') as rol,
                    u.activo,
                    u.bloqueado_hasta,
                    u.actualizado_en
                FROM usuarios u
                LEFT JOIN roles r ON r.id = u.rol_id
                WHERE u.empresa_id = ${empresaId}
                ORDER BY u.nombre_completo ASC
            `

            return staff
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.put('/admin/staff/:id', async (request, reply) => {
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
            const payload = updateStaffSchema.parse(request.body ?? {})
            if (!payload.nombreCompleto && !payload.rolOperativo) {
                return reply.code(400).send({ error: 'Debes enviar al menos un campo para actualizar' })
            }

            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const usuarios = await sqlAdmin`
                SELECT id, nombre_completo, rol_id, activo
                FROM usuarios
                WHERE id = ${id}
                  AND empresa_id = ${empresaId}
                LIMIT 1
            `
            if (usuarios.length === 0) {
                return reply.code(404).send({ error: 'Usuario no encontrado' })
            }

            const rolId = payload.rolOperativo
                ? await resolveRoleId(empresaId, payload.rolOperativo)
                : usuarios[0].rol_id

            const nombre = payload.nombreCompleto?.trim() || usuarios[0].nombre_completo

            const [updated] = await sqlAdmin`
                UPDATE usuarios
                SET nombre_completo = ${nombre},
                    rol_id = ${rolId},
                    actualizado_en = NOW()
                WHERE id = ${id}
                  AND empresa_id = ${empresaId}
                RETURNING id, nombre_completo as nombre, activo, bloqueado_hasta
            `

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'staff_actualizado',
                entidad: 'usuario',
                entidadId: id,
                metadata: {
                    nombreCompleto: nombre,
                    rolOperativo: payload.rolOperativo || null,
                },
                request,
            })

            return updated
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            if ((err as any)?.codigo === 'PUNTO_VENTA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'PUNTO_VENTA_FUERA_EMPRESA' })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.put('/admin/staff/:id/estado', async (request, reply) => {
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
            const { activo } = changeStaffStatusSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const [updated] = await sqlAdmin`
                UPDATE usuarios
                SET activo = ${activo},
                    actualizado_en = NOW()
                WHERE id = ${id}
                  AND empresa_id = ${empresaId}
                RETURNING id, nombre_completo as nombre, activo, bloqueado_hasta
            `

            if (!updated) {
                return reply.code(404).send({ error: 'Usuario no encontrado' })
            }

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: activo ? 'staff_activado' : 'staff_inactivado',
                entidad: 'usuario',
                entidadId: id,
                metadata: { activo },
                request,
            })

            return updated
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            if ((err as any)?.codigo === 'CATEGORIA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'CATEGORIA_FUERA_EMPRESA' })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.post('/admin/staff/:id/reset-pin', async (request, reply) => {
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

            const usuarios = await sqlAdmin`
                SELECT id, nombre_completo
                FROM usuarios
                WHERE id = ${id}
                  AND empresa_id = ${empresaId}
                LIMIT 1
            `
            if (usuarios.length === 0) {
                return reply.code(404).send({ error: 'Usuario no encontrado' })
            }

            const pin = await generateUniquePin(empresaId)
            const pinFingerprint = buildPinFingerprint(empresaId, pin)
            const pinHash = await authService.hashPassword(pin)

            await sqlAdmin`
                UPDATE usuarios
                SET pin_hash = ${pinHash},
                    pin_fingerprint = ${pinFingerprint},
                    intentos_fallidos = 0,
                    bloqueado_hasta = NULL,
                    actualizado_en = NOW()
                WHERE id = ${id}
                  AND empresa_id = ${empresaId}
            `

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'staff_pin_reasignado',
                entidad: 'usuario',
                entidadId: id,
                metadata: { nombreCompleto: usuarios[0].nombre_completo },
                request,
            })

            return {
                id,
                nombreCompleto: usuarios[0].nombre_completo,
                pin,
            }
        } catch (err) {
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

    // Admin: Crear punto de venta
    fastify.post('/admin/puntos-venta', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) {
            return reply.code(401).send({ error: 'No autorizado' })
        }

        const session = await authService.verifySession(token)
        if (!session) {
            return reply.code(401).send({ error: 'Sesión inválida' })
        }

        try {
            const payload = crearPuntoVentaSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const [created] = await sql`
                INSERT INTO puntos_venta (
                    empresa_id,
                    nombre,
                    codigo,
                    direccion,
                    telefono_contacto,
                    activo,
                    creado_en,
                    actualizado_en
                )
                VALUES (
                    ${empresaId},
                    ${payload.nombre.trim()},
                    ${payload.codigo?.trim() || null},
                    ${payload.direccion?.trim() || null},
                    ${payload.telefono_contacto?.trim() || null},
                    true,
                    NOW(),
                    NOW()
                )
                RETURNING id, nombre, codigo, direccion, telefono_contacto, activo, creado_en, actualizado_en
            `

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'punto_venta_creado',
                entidad: 'punto_venta',
                entidadId: created.id,
                metadata: {
                    nombre: created.nombre,
                    codigo: created.codigo,
                },
                request,
            })

            return created
        } catch (err: any) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }

            if (err?.code === '23505') {
                return reply.code(409).send({ error: 'CODIGO_PUNTO_VENTA_DUPLICADO', mensaje: 'Ya existe un punto de venta con ese código.' })
            }

            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // Admin: Actualizar punto de venta
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
            if (!payload.nombre && !payload.codigo && payload.direccion === undefined && payload.telefono_contacto === undefined) {
                return reply.code(400).send({ error: 'Debes enviar al menos un campo para actualizar' })
            }
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const current = await sql`
                SELECT id, nombre, codigo
                FROM puntos_venta
                WHERE id = ${id}
                  AND empresa_id = ${empresaId}
                LIMIT 1
            `

            if (current.length === 0) {
                return reply.code(404).send({ error: 'Punto de venta no encontrado' })
            }

            const nombre = payload.nombre?.trim() || current[0].nombre
            const codigo = payload.codigo?.trim() || current[0].codigo || null
            const direccion = payload.direccion?.trim() || null
            const telefono = payload.telefono_contacto?.trim() || null

            const updated = await sql`
                UPDATE puntos_venta
                SET nombre = ${nombre},
                    codigo = ${codigo},
                    direccion = ${direccion},
                    telefono_contacto = ${telefono},
                    actualizado_en = NOW()
                WHERE id = ${id}
                AND empresa_id = ${empresaId}
                RETURNING id, nombre, codigo, direccion, telefono_contacto, activo, creado_en, actualizado_en
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
                    nombre,
                    codigo,
                    direccion,
                    telefono_contacto: telefono,
                },
                request
            })

            return updated[0]
        } catch (err: any) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }

            if (err?.code === '23505') {
                return reply.code(409).send({ error: 'CODIGO_PUNTO_VENTA_DUPLICADO', mensaje: 'Ya existe un punto de venta con ese código.' })
            }

            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // Admin: Activar/Inactivar punto de venta
    fastify.put('/admin/puntos-venta/:id/estado', async (request, reply) => {
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
            const { activo } = estadoPuntoVentaSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const [puntoVentaActual] = await sql`
                SELECT id, activo
                FROM puntos_venta
                WHERE id = ${id}
                  AND empresa_id = ${empresaId}
                LIMIT 1
            `

            if (!puntoVentaActual) {
                return reply.code(404).send({ error: 'Punto de venta no encontrado' })
            }

            if (!activo) {
                if (puntoVentaActual.activo) {
                    const otrosPuntosActivos = await sql`
                        SELECT id
                        FROM puntos_venta
                        WHERE empresa_id = ${empresaId}
                          AND activo = true
                          AND id <> ${id}
                        LIMIT 1
                    `

                    if (otrosPuntosActivos.length === 0) {
                        return reply.code(409).send({
                            error: 'ULTIMO_PUNTO_VENTA_ACTIVO',
                            mensaje: 'No se puede inactivar el último punto de venta activo de la empresa.',
                        })
                    }
                }

                const cajasAbiertas = await sql`
                    SELECT id
                    FROM cajas
                    WHERE empresa_id = ${empresaId}
                      AND punto_venta_id = ${id}
                      AND activa = true
                      AND abierta = true
                    LIMIT 1
                `

                if (cajasAbiertas.length > 0) {
                    return reply.code(409).send({
                        error: 'PUNTO_VENTA_TIENE_CAJA_ABIERTA',
                        mensaje: 'No se puede inactivar el punto de venta porque tiene una caja abierta. Cierra la caja primero.',
                    })
                }
            }

            const [updated] = await sql`
                UPDATE puntos_venta
                SET activo = ${activo},
                    actualizado_en = NOW()
                WHERE id = ${id}
                  AND empresa_id = ${empresaId}
                RETURNING id, nombre, codigo, direccion, telefono_contacto, activo, creado_en, actualizado_en
            `

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: activo ? 'punto_venta_activado' : 'punto_venta_inactivado',
                entidad: 'punto_venta',
                entidadId: id,
                metadata: { activo },
                request,
            })

            return updated
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }

            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.get('/admin/categorias', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const { puntoVentaId, incluirInactivas } = categoriasListadoSchema.parse(request.query ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
            if (puntoVentaId) {
                await assertPuntoVentaEmpresa(empresaId, puntoVentaId)
            }

            const categorias = await sqlAdmin`
                SELECT
                    c.id,
                    c.nombre,
                    c.activa_base,
                    c.orden_ui_base,
                    c.defaults_config,
                    c.creado_en,
                    c.actualizado_en,
                    cpv.punto_venta_id,
                    cpv.activa_en_pv,
                    cpv.orden_ui_pv,
                    COALESCE(cpv.activa_en_pv, c.activa_base) AS activa_efectiva,
                    COALESCE(cpv.orden_ui_pv, c.orden_ui_base) AS orden_ui_efectivo
                FROM categorias_catalogo c
                LEFT JOIN categorias_punto_venta cpv
                    ON cpv.categoria_id = c.id
                   AND cpv.punto_venta_id = ${puntoVentaId ?? null}
                WHERE c.empresa_id = ${empresaId}
                  ${incluirInactivas === 'false' ? sqlAdmin`AND COALESCE(cpv.activa_en_pv, c.activa_base) = true` : sqlAdmin``}
                ORDER BY COALESCE(cpv.orden_ui_pv, c.orden_ui_base) ASC, c.nombre ASC
            `

            return categorias.map((c: any) => ({
                id: c.id,
                nombre: c.nombre,
                activaBase: Boolean(c.activa_base),
                ordenUiBase: Number(c.orden_ui_base ?? 0),
                defaultsConfig: c.defaults_config ?? {},
                puntoVentaId: c.punto_venta_id ?? null,
                activaEnPv: c.activa_en_pv === null ? null : Boolean(c.activa_en_pv),
                ordenUiPv: c.orden_ui_pv === null ? null : Number(c.orden_ui_pv),
                activaEfectiva: Boolean(c.activa_efectiva),
                ordenUiEfectivo: Number(c.orden_ui_efectivo ?? 0),
                creadoEn: c.creado_en,
                actualizadoEn: c.actualizado_en,
            }))
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            if ((err as any)?.codigo === 'PUNTO_VENTA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'PUNTO_VENTA_FUERA_EMPRESA' })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.post('/admin/categorias', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const payload = crearCategoriaSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
            const nombre = normalizeCategoriaNombre(payload.nombre)
            const nombreNormalizado = categoriaNombreNormalizado(payload.nombre)

            let puntoVentaIds: string[] = []
            if (payload.scope === 'solo_pv') {
                if (!payload.puntoVentaId) {
                    return reply.code(400).send({ error: 'puntoVentaId es requerido para scope solo_pv' })
                }
                await assertPuntoVentaEmpresa(empresaId, payload.puntoVentaId)
                puntoVentaIds = [payload.puntoVentaId]
            } else if (payload.scope === 'pvs') {
                if (!payload.puntoVentaIds || payload.puntoVentaIds.length === 0) {
                    return reply.code(400).send({ error: 'puntoVentaIds es requerido para scope pvs' })
                }
                for (const pvId of payload.puntoVentaIds) {
                    await assertPuntoVentaEmpresa(empresaId, pvId)
                }
                puntoVentaIds = [...new Set(payload.puntoVentaIds)]
            } else {
                const pvs = await sqlAdmin`
                    SELECT id
                    FROM puntos_venta
                    WHERE empresa_id = ${empresaId}
                      AND activo = true
                `
                puntoVentaIds = pvs.map((pv: any) => pv.id as string)
            }

            const created = await sqlAdmin.begin(async (tx: any) => {
                const exists = await tx`
                    SELECT id
                    FROM categorias_catalogo
                    WHERE empresa_id = ${empresaId}
                      AND nombre_normalizado = ${nombreNormalizado}
                    LIMIT 1
                `

                if (exists.length > 0) {
                    const error = new Error('Ya existe una categoria con ese nombre')
                    ;(error as any).codigo = 'CATEGORIA_DUPLICADA'
                    throw error
                }

                const [categoria] = await tx`
                    INSERT INTO categorias_catalogo (
                        empresa_id,
                        nombre,
                        nombre_normalizado,
                        activa_base,
                        orden_ui_base,
                        defaults_config
                    )
                    VALUES (
                        ${empresaId},
                        ${nombre},
                        ${nombreNormalizado},
                        true,
                        ${payload.ordenUiBase ?? 0},
                        ${JSON.stringify(payload.defaultsConfig ?? {})}::jsonb
                    )
                    RETURNING id, nombre, activa_base, orden_ui_base, defaults_config, creado_en, actualizado_en
                `

                if (puntoVentaIds.length > 0) {
                    const puntoVentaArray = tx.array(puntoVentaIds as any)
                    await tx`
                        INSERT INTO categorias_punto_venta (
                            categoria_id,
                            punto_venta_id,
                            activa_en_pv,
                            orden_ui_pv
                        )
                        SELECT
                            ${categoria.id},
                            pv.id,
                            true,
                            NULL
                        FROM puntos_venta pv
                        WHERE pv.id = ANY(${puntoVentaArray}::uuid[])
                          AND pv.empresa_id = ${empresaId}
                        ON CONFLICT (categoria_id, punto_venta_id) DO NOTHING
                    `
                }

                return categoria
            })

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'categoria_creada',
                entidad: 'categoria_catalogo',
                entidadId: created.id,
                metadata: {
                    nombre: created.nombre,
                    scope: payload.scope,
                    puntoVentaIds,
                    defaultsConfig: payload.defaultsConfig ?? {},
                },
                request,
            })

            return {
                id: created.id,
                nombre: created.nombre,
                activaBase: Boolean(created.activa_base),
                ordenUiBase: Number(created.orden_ui_base ?? 0),
                defaultsConfig: created.defaults_config ?? {},
                scope: payload.scope,
                puntoVentaIds,
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            if ((err as any)?.codigo === 'PUNTO_VENTA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'PUNTO_VENTA_FUERA_EMPRESA' })
            }
            if ((err as any)?.codigo === 'CATEGORIA_DUPLICADA') {
                return reply.code(409).send({ error: 'CATEGORIA_DUPLICADA' })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.put('/admin/categorias/:id', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const { id } = request.params as { id: string }
            const payload = actualizarCategoriaSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const rows = await sqlAdmin`
                SELECT id, nombre, nombre_normalizado, orden_ui_base, defaults_config
                FROM categorias_catalogo
                WHERE id = ${id}
                  AND empresa_id = ${empresaId}
                LIMIT 1
            `

            if (rows.length === 0) {
                return reply.code(404).send({ error: 'Categoria no encontrada' })
            }

            const current = rows[0]
            const nextNombre = payload.nombre ? normalizeCategoriaNombre(payload.nombre) : current.nombre
            const nextNombreNormalizado = payload.nombre ? categoriaNombreNormalizado(payload.nombre) : current.nombre_normalizado

            const duplicate = await sqlAdmin`
                SELECT id
                FROM categorias_catalogo
                WHERE empresa_id = ${empresaId}
                  AND nombre_normalizado = ${nextNombreNormalizado}
                  AND id <> ${id}
                LIMIT 1
            `
            if (duplicate.length > 0) {
                return reply.code(409).send({ error: 'CATEGORIA_DUPLICADA' })
            }

            const mergedDefaults = {
                ...(current.defaults_config ?? {}),
                ...(payload.defaultsConfig ?? {}),
            }

            const [updated] = await sqlAdmin`
                UPDATE categorias_catalogo
                SET nombre = ${nextNombre},
                    nombre_normalizado = ${nextNombreNormalizado},
                    orden_ui_base = ${payload.ordenUiBase ?? current.orden_ui_base},
                    defaults_config = ${JSON.stringify(mergedDefaults)}::jsonb,
                    actualizado_en = NOW()
                WHERE id = ${id}
                  AND empresa_id = ${empresaId}
                RETURNING id, nombre, activa_base, orden_ui_base, defaults_config, actualizado_en
            `

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'categoria_actualizada',
                entidad: 'categoria_catalogo',
                entidadId: id,
                metadata: {
                    nombre: updated.nombre,
                },
                request,
            })

            return {
                id: updated.id,
                nombre: updated.nombre,
                activaBase: Boolean(updated.activa_base),
                ordenUiBase: Number(updated.orden_ui_base ?? 0),
                defaultsConfig: updated.defaults_config ?? {},
                actualizadoEn: updated.actualizado_en,
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.put('/admin/categorias/:id/estado', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const { id } = request.params as { id: string }
            const { activaBase } = estadoCategoriaSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const [updated] = await sqlAdmin`
                UPDATE categorias_catalogo
                SET activa_base = ${activaBase},
                    actualizado_en = NOW()
                WHERE id = ${id}
                  AND empresa_id = ${empresaId}
                RETURNING id, nombre, activa_base, actualizado_en
            `

            if (!updated) {
                return reply.code(404).send({ error: 'Categoria no encontrada' })
            }

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: activaBase ? 'categoria_activada' : 'categoria_inactivada',
                entidad: 'categoria_catalogo',
                entidadId: id,
                metadata: {
                    nombre: updated.nombre,
                    activaBase,
                },
                request,
            })

            return {
                id: updated.id,
                nombre: updated.nombre,
                activaBase: Boolean(updated.activa_base),
                actualizadoEn: updated.actualizado_en,
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.put('/admin/categorias/:id/pv', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const { id } = request.params as { id: string }
            const payload = categoriaPvUpdateSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
            await assertPuntoVentaEmpresa(empresaId, payload.puntoVentaId)
            await assertCategoriaEmpresa(empresaId, id)

            const current = await sqlAdmin`
                SELECT activa_en_pv, orden_ui_pv
                FROM categorias_punto_venta
                WHERE categoria_id = ${id}
                  AND punto_venta_id = ${payload.puntoVentaId}
                LIMIT 1
            `

            const nextActiva = payload.activaEnPv ?? Boolean(current[0]?.activa_en_pv ?? true)
            const nextOrden = payload.ordenUiPv !== undefined
                ? payload.ordenUiPv
                : (current[0]?.orden_ui_pv ?? null)

            const [updated] = await sqlAdmin`
                INSERT INTO categorias_punto_venta (
                    categoria_id,
                    punto_venta_id,
                    activa_en_pv,
                    orden_ui_pv
                )
                VALUES (
                    ${id},
                    ${payload.puntoVentaId},
                    ${nextActiva},
                    ${nextOrden}
                )
                ON CONFLICT (categoria_id, punto_venta_id)
                DO UPDATE SET
                    activa_en_pv = ${nextActiva},
                    orden_ui_pv = ${nextOrden},
                    actualizado_en = NOW()
                RETURNING categoria_id, punto_venta_id, activa_en_pv, orden_ui_pv, actualizado_en
            `

            await logAuditEvent({
                empresaId,
                puntoVentaId: payload.puntoVentaId,
                usuarioId: session.usuario_id,
                accion: 'categoria_configurada_pv',
                entidad: 'categoria_catalogo',
                entidadId: id,
                metadata: {
                    activaEnPv: nextActiva,
                    ordenUiPv: nextOrden,
                },
                request,
            })

            return {
                categoriaId: updated.categoria_id,
                puntoVentaId: updated.punto_venta_id,
                activaEnPv: Boolean(updated.activa_en_pv),
                ordenUiPv: updated.orden_ui_pv === null ? null : Number(updated.orden_ui_pv),
                actualizadoEn: updated.actualizado_en,
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            if ((err as any)?.codigo === 'PUNTO_VENTA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'PUNTO_VENTA_FUERA_EMPRESA' })
            }
            if ((err as any)?.codigo === 'CATEGORIA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'CATEGORIA_FUERA_EMPRESA' })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.post('/admin/categorias/:id/aplicar', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const { id } = request.params as { id: string }
            const payload = categoriaAplicarSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
            await assertCategoriaEmpresa(empresaId, id)

            let puntoVentaIds: string[] = []
            if (payload.scope === 'todos_pv') {
                const pvs = await sqlAdmin`
                    SELECT id
                    FROM puntos_venta
                    WHERE empresa_id = ${empresaId}
                      AND activo = true
                `
                puntoVentaIds = pvs.map((pv: any) => pv.id as string)
            } else {
                if (!payload.puntoVentaIds || payload.puntoVentaIds.length === 0) {
                    return reply.code(400).send({ error: 'puntoVentaIds es requerido cuando scope=pvs' })
                }
                for (const pvId of payload.puntoVentaIds) {
                    await assertPuntoVentaEmpresa(empresaId, pvId)
                }
                puntoVentaIds = [...new Set(payload.puntoVentaIds)]
            }

            if (puntoVentaIds.length > 0) {
                const puntoVentaArray = sqlAdmin.array(puntoVentaIds as any)
                await sqlAdmin`
                    INSERT INTO categorias_punto_venta (
                        categoria_id,
                        punto_venta_id,
                        activa_en_pv,
                        orden_ui_pv
                    )
                    SELECT
                        ${id},
                        pv.id,
                        ${payload.activaEnPv},
                        NULL
                    FROM puntos_venta pv
                    WHERE pv.id = ANY(${puntoVentaArray}::uuid[])
                      AND pv.empresa_id = ${empresaId}
                    ON CONFLICT (categoria_id, punto_venta_id)
                    DO UPDATE SET
                        activa_en_pv = ${payload.activaEnPv},
                        actualizado_en = NOW()
                `
            }

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'categoria_aplicada_pvs',
                entidad: 'categoria_catalogo',
                entidadId: id,
                metadata: {
                    scope: payload.scope,
                    activaEnPv: payload.activaEnPv,
                    puntoVentaIds,
                },
                request,
            })

            return {
                success: true,
                categoriaId: id,
                scope: payload.scope,
                puntoVentaIds,
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            if ((err as any)?.codigo === 'PUNTO_VENTA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'PUNTO_VENTA_FUERA_EMPRESA' })
            }
            if ((err as any)?.codigo === 'CATEGORIA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'CATEGORIA_FUERA_EMPRESA' })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    // Admin: Catalogo ABM
    fastify.get('/admin/catalogo/items', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const { activo, puntoVentaId, categoriaId } = catalogoScopeSchema.parse(request.query ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            if (puntoVentaId) {
                await assertPuntoVentaEmpresa(empresaId, puntoVentaId)
            }
            if (categoriaId) {
                await assertCategoriaEmpresa(empresaId, categoriaId)
            }

            const activoFiltro = activo === undefined ? null : activo === 'true'

            const items = await sqlAdmin`
                SELECT
                    i.id,
                    i.nombre,
                    i.categoria_id,
                    COALESCE(c.nombre, i.categoria, 'Sin categoría') as categoria,
                    COALESCE(ipv.precio_venta_pv, i.precio_venta) as precio_venta,
                    COALESCE(ipv.activo_en_pv, i.activo) as activo,
                    COALESCE(ipv.orden_ui_pv, i.orden_ui) as orden_ui,
                    i.creado_en,
                    i.actualizado_en,
                    i.costo,
                    i.maneja_stock,
                    CASE
                        WHEN i.maneja_stock = true THEN COALESCE(ipv.stock_actual_pv, i.stock_actual)
                        ELSE i.stock_actual
                    END as stock_actual,
                    CASE
                        WHEN i.maneja_stock = true THEN COALESCE(ipv.stock_minimo_pv, i.stock_minimo)
                        ELSE i.stock_minimo
                    END as stock_minimo,
                    i.permite_consumo_staff,
                    i.duracion_min,
                    i.tipo_cantidad,
                    i.precio_venta as precio_venta_base,
                    i.activo as activo_base,
                    i.orden_ui as orden_ui_base,
                    ipv.punto_venta_id as override_punto_venta_id,
                    COALESCE(cpv.activa_en_pv, c.activa_base, true) as categoria_activa_en_pv,
                    COALESCE(cpv.orden_ui_pv, c.orden_ui_base, 0) as categoria_orden_ui
                FROM items i
                LEFT JOIN categorias_catalogo c ON c.id = i.categoria_id
                LEFT JOIN categorias_punto_venta cpv
                    ON cpv.categoria_id = i.categoria_id
                   AND cpv.punto_venta_id = ${puntoVentaId ?? null}
                LEFT JOIN items_punto_venta ipv
                    ON ipv.item_id = i.id
                   AND ipv.punto_venta_id = ${puntoVentaId ?? null}
                WHERE i.empresa_id = ${empresaId}
                  ${categoriaId ? sqlAdmin`AND i.categoria_id = ${categoriaId}` : sqlAdmin``}
                  ${puntoVentaId ? sqlAdmin`AND ipv.punto_venta_id IS NOT NULL` : sqlAdmin``}
                  ${activoFiltro === null ? sqlAdmin`` : puntoVentaId ? sqlAdmin`AND ipv.activo_en_pv = ${activoFiltro}` : sqlAdmin`AND i.activo = ${activoFiltro}`}
                ORDER BY COALESCE(cpv.orden_ui_pv, c.orden_ui_base, 0) ASC, COALESCE(ipv.orden_ui_pv, i.orden_ui) ASC, i.nombre ASC
            `

            return items
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.post('/admin/catalogo/items', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const data = crearCatalogoItemSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
            let targetPuntoVentaIds: string[] = []

            if (data.scope === 'solo_pv' && !data.puntoVentaId) {
                return reply.code(400).send({ error: 'puntoVentaId es requerido para scope solo_pv' })
            }
            if (data.puntoVentaId) {
                await assertPuntoVentaEmpresa(empresaId, data.puntoVentaId)
            }

            if (data.scope === 'solo_pv') {
                targetPuntoVentaIds = data.puntoVentaId ? [data.puntoVentaId] : []
            } else {
                const pvs = await sqlAdmin`
                    SELECT id
                    FROM puntos_venta
                    WHERE empresa_id = ${empresaId}
                      AND activo = true
                `
                targetPuntoVentaIds = pvs.map((pv: any) => pv.id as string)
            }

            const item = await sqlAdmin.begin(async (tx: any) => {
                const categoriaIdResolved = await resolveCategoriaIdFromInput(tx, empresaId, data.categoriaId, data.categoria)
                const categoriaDefaults = await getCategoriaDefaults(empresaId, categoriaIdResolved)
                const defaults = (categoriaDefaults?.defaultsConfig ?? {}) as Record<string, any>

                let categoriaNombreLegacy: string | null = data.categoria?.trim() || null
                if (categoriaIdResolved) {
                    const categoriaRows = await tx`
                        SELECT nombre
                        FROM categorias_catalogo
                        WHERE id = ${categoriaIdResolved}
                        LIMIT 1
                    `
                    categoriaNombreLegacy = categoriaRows[0]?.nombre ?? categoriaNombreLegacy
                }

                const manejaStock = data.maneja_stock ?? Boolean(defaults.maneja_stock ?? false)
                const permiteStaff = data.permite_consumo_staff ?? Boolean(defaults.permite_consumo_staff ?? true)
                const tipoCantidad = data.tipo_cantidad ?? (defaults.tipo_cantidad === 'entero' || defaults.tipo_cantidad === 'decimal' ? defaults.tipo_cantidad : null)
                const costo = data.costo ?? 0
                const stockActual = manejaStock ? (data.stock_actual ?? 0) : 0
                const stockMinimo = manejaStock ? (data.stock_minimo ?? 0) : 0
                const duracionMin = data.duracion_min ?? null

                const [base] = await tx`
                    INSERT INTO items (
                        nombre,
                        categoria,
                        categoria_id,
                        precio_venta,
                        activo,
                        orden_ui,
                        tipo_cantidad,
                        costo,
                        maneja_stock,
                        stock_actual,
                        stock_minimo,
                        permite_consumo_staff,
                        duracion_min,
                        empresa_id
                    )
                    VALUES (
                        ${data.nombre.trim()},
                        ${categoriaNombreLegacy},
                        ${categoriaIdResolved},
                        ${data.precio_venta},
                        ${data.activo ?? true},
                        ${data.orden_ui ?? 0},
                        ${tipoCantidad},
                        ${costo},
                        ${manejaStock},
                        ${stockActual},
                        ${stockMinimo},
                        ${permiteStaff},
                        ${duracionMin},
                        ${empresaId}
                    )
                    RETURNING id, nombre, categoria, categoria_id, precio_venta, activo, orden_ui, tipo_cantidad, costo, maneja_stock, stock_actual, stock_minimo, permite_consumo_staff, duracion_min, creado_en, actualizado_en
                `

                if (targetPuntoVentaIds.length > 0) {
                    const targetPvArray = tx.array(targetPuntoVentaIds as any)
                    await tx`
                        INSERT INTO items_punto_venta (
                            item_id,
                            punto_venta_id,
                            activo_en_pv,
                            precio_venta_pv,
                            orden_ui_pv,
                            stock_actual_pv,
                            stock_minimo_pv
                        )
                        SELECT
                            ${base.id},
                            pv.id,
                            ${data.activo ?? true},
                            NULL,
                            NULL,
                            ${manejaStock ? stockActual : null},
                            ${manejaStock ? stockMinimo : null}
                        FROM puntos_venta pv
                        WHERE pv.id = ANY(${targetPvArray}::uuid[])
                          AND pv.empresa_id = ${empresaId}
                        ON CONFLICT (item_id, punto_venta_id)
                        DO NOTHING
                    `
                }

                if (categoriaIdResolved && targetPuntoVentaIds.length > 0) {
                    const targetPvArray = tx.array(targetPuntoVentaIds as any)
                    await tx`
                        INSERT INTO categorias_punto_venta (
                            categoria_id,
                            punto_venta_id,
                            activa_en_pv,
                            orden_ui_pv
                        )
                        SELECT
                            ${categoriaIdResolved},
                            pv.id,
                            true,
                            NULL
                        FROM puntos_venta pv
                        WHERE pv.id = ANY(${targetPvArray}::uuid[])
                          AND pv.empresa_id = ${empresaId}
                        ON CONFLICT (categoria_id, punto_venta_id)
                        DO UPDATE SET
                            activa_en_pv = true,
                            actualizado_en = NOW()
                    `
                }

                return base
            })

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'catalogo_item_creado',
                entidad: 'item',
                entidadId: item.id,
                metadata: {
                    nombre: item.nombre,
                    scope: data.scope,
                    puntoVentaId: data.puntoVentaId ?? null,
                    categoriaId: item.categoria_id ?? null,
                },
                request,
            })

            return item
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            if ((err as any)?.codigo === 'CATEGORIA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'CATEGORIA_FUERA_EMPRESA' })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.put('/admin/catalogo/items/:id', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const { id } = request.params as { id: string }
            const data = actualizarCatalogoItemSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const rows = await sqlAdmin`
                SELECT id, nombre, categoria, categoria_id, precio_venta, activo, orden_ui, tipo_cantidad, costo, maneja_stock, stock_actual, stock_minimo, permite_consumo_staff, duracion_min
                FROM items
                WHERE id = ${id}
                  AND empresa_id = ${empresaId}
                LIMIT 1
            `
            if (rows.length === 0) {
                return reply.code(404).send({ error: 'Item no encontrado' })
            }

            const current = rows[0]
            const resolvedCategoriaId = (data.categoriaId !== undefined || data.categoria !== undefined)
                ? await resolveCategoriaIdFromInput(sqlAdmin, empresaId, data.categoriaId, data.categoria)
                : current.categoria_id

            let categoriaNombreLegacy = current.categoria
            if (resolvedCategoriaId) {
                const categoriaRows = await sqlAdmin`
                    SELECT nombre
                    FROM categorias_catalogo
                    WHERE id = ${resolvedCategoriaId}
                      AND empresa_id = ${empresaId}
                    LIMIT 1
                `
                categoriaNombreLegacy = categoriaRows[0]?.nombre ?? categoriaNombreLegacy
            } else if (data.categoriaId === null) {
                categoriaNombreLegacy = null
            } else if (data.categoria !== undefined) {
                categoriaNombreLegacy = data.categoria?.trim() || null
            }

            const [updated] = await sqlAdmin`
                UPDATE items
                SET nombre = ${data.nombre?.trim() || current.nombre},
                    categoria = ${categoriaNombreLegacy},
                    categoria_id = ${resolvedCategoriaId ?? null},
                    precio_venta = ${data.precio_venta ?? current.precio_venta},
                    activo = ${data.activo ?? current.activo},
                    orden_ui = ${data.orden_ui ?? current.orden_ui},
                    tipo_cantidad = ${data.tipo_cantidad ?? current.tipo_cantidad ?? null},
                    costo = ${data.costo ?? current.costo ?? 0},
                    maneja_stock = ${data.maneja_stock ?? current.maneja_stock ?? false},
                    stock_actual = ${data.stock_actual ?? current.stock_actual ?? 0},
                    stock_minimo = ${data.stock_minimo ?? current.stock_minimo ?? 0},
                    permite_consumo_staff = ${data.permite_consumo_staff ?? current.permite_consumo_staff ?? true},
                    duracion_min = ${data.duracion_min ?? current.duracion_min ?? null},
                    actualizado_en = NOW()
                WHERE id = ${id}
                  AND empresa_id = ${empresaId}
                RETURNING id, nombre, categoria, categoria_id, precio_venta, activo, orden_ui, tipo_cantidad, costo, maneja_stock, stock_actual, stock_minimo, permite_consumo_staff, duracion_min, actualizado_en
            `

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: 'catalogo_item_actualizado',
                entidad: 'item',
                entidadId: id,
                metadata: {
                    nombre: updated.nombre,
                    categoriaId: updated.categoria_id ?? null,
                },
                request,
            })

            return updated
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            if ((err as any)?.codigo === 'CATEGORIA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'CATEGORIA_FUERA_EMPRESA' })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.put('/admin/catalogo/items/:id/estado', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const { id } = request.params as { id: string }
            const { activo } = estadoCatalogoItemSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const [updated] = await sqlAdmin`
                UPDATE items
                SET activo = ${activo},
                    actualizado_en = NOW()
                WHERE id = ${id}
                  AND empresa_id = ${empresaId}
                RETURNING id, nombre, activo, actualizado_en
            `

            if (!updated) {
                return reply.code(404).send({ error: 'Item no encontrado' })
            }

            await logAuditEvent({
                empresaId,
                usuarioId: session.usuario_id,
                accion: activo ? 'catalogo_item_activado' : 'catalogo_item_inactivado',
                entidad: 'item',
                entidadId: id,
                metadata: {
                    activo,
                    nombre: updated.nombre,
                },
                request,
            })

            return updated
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.get('/admin/catalogo/items/:id/pv-opciones', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const { id } = request.params as { id: string }
            const { excludePuntoVentaId } = catalogoPvOpcionesSchema.parse(request.query ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            const itemRows = await sqlAdmin`
                SELECT i.id
                FROM items i
                WHERE i.id = ${id}
                  AND i.empresa_id = ${empresaId}
                LIMIT 1
            `

            if (itemRows.length === 0) {
                return reply.code(404).send({ error: 'Item no encontrado' })
            }

            const opciones = await sqlAdmin`
                SELECT
                    pv.id AS punto_venta_id,
                    pv.nombre AS punto_venta_nombre,
                    COALESCE(ipv.precio_venta_pv, i.precio_venta) AS precio_venta,
                    COALESCE(i.costo, 0) AS costo,
                    COALESCE(ipv.stock_minimo_pv, i.stock_minimo, 0) AS stock_minimo,
                    COALESCE(i.permite_consumo_staff, true) AS permite_consumo_staff,
                    COALESCE(ipv.orden_ui_pv, i.orden_ui, 0) AS orden_ui
                FROM items i
                JOIN items_punto_venta ipv ON ipv.item_id = i.id
                JOIN puntos_venta pv ON pv.id = ipv.punto_venta_id
                WHERE i.id = ${id}
                  AND i.empresa_id = ${empresaId}
                  AND pv.activo = true
                  AND ipv.activo_en_pv = true
                  AND ${excludePuntoVentaId ? sqlAdmin`ipv.punto_venta_id <> ${excludePuntoVentaId}` : sqlAdmin`TRUE`}
                ORDER BY pv.nombre ASC
            `

            return opciones.map((o: any) => ({
                puntoVentaId: o.punto_venta_id,
                puntoVentaNombre: o.punto_venta_nombre,
                precioVentaPv: Number(o.precio_venta ?? 0),
                costo: Number(o.costo ?? 0),
                stockMinimoPv: Number(o.stock_minimo ?? 0),
                permiteConsumoStaff: Boolean(o.permite_consumo_staff),
                ordenUiPv: Number(o.orden_ui ?? 0),
            }))
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.post('/admin/inventario/ajuste', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const payload = inventarioAjusteSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
            await assertPuntoVentaEmpresa(empresaId, payload.puntoVentaId)

            const items = await sqlAdmin`
                SELECT i.id, i.nombre, i.maneja_stock, i.stock_actual, i.stock_minimo
                FROM items i
                WHERE i.id = ${payload.itemId}
                  AND i.empresa_id = ${empresaId}
                LIMIT 1
            `

            if (items.length === 0) {
                return reply.code(404).send({ error: 'Item no encontrado' })
            }

            const item = items[0]
            if (!item.maneja_stock) {
                return reply.code(409).send({ error: 'El item no maneja stock' })
            }

            const existingPvRows = await sqlAdmin`
                SELECT id, stock_actual_pv
                FROM items_punto_venta
                WHERE item_id = ${payload.itemId}
                  AND punto_venta_id = ${payload.puntoVentaId}
                LIMIT 1
            `

            if (existingPvRows.length === 0) {
                return reply.code(409).send({
                    error: 'ITEM_NO_EXISTE_EN_PV',
                    mensaje: 'Este producto no existe en el punto de venta seleccionado. Debes crearlo en ese PV antes de registrar compra.',
                })
            }

            const result = await sqlAdmin.begin(async (tx: any) => {
                const currentRows = await tx`
                    SELECT stock_actual_pv
                    FROM items_punto_venta
                    WHERE item_id = ${payload.itemId}
                      AND punto_venta_id = ${payload.puntoVentaId}
                    LIMIT 1
                `

                const stockAnterior = Number(currentRows[0]?.stock_actual_pv ?? 0)
                const stockNuevo = Number(payload.nuevoStock)
                const diferencia = stockNuevo - stockAnterior

                await tx`
                    UPDATE items_punto_venta
                    SET stock_actual_pv = ${stockNuevo},
                        actualizado_en = NOW()
                    WHERE item_id = ${payload.itemId}
                      AND punto_venta_id = ${payload.puntoVentaId}
                `

                await tx`
                    INSERT INTO inventario_movimientos (
                        empresa_id,
                        punto_venta_id,
                        item_id,
                        usuario_id,
                        tipo_movimiento,
                        cantidad,
                        stock_anterior,
                        stock_nuevo,
                        motivo,
                        metadata
                    )
                    VALUES (
                        ${empresaId},
                        ${payload.puntoVentaId},
                        ${payload.itemId},
                        ${session.usuario_id},
                        'ajuste_manual',
                        ${diferencia},
                        ${stockAnterior},
                        ${stockNuevo},
                        ${payload.motivo.trim()},
                        ${JSON.stringify({ origen: 'admin_catalogo' })}::jsonb
                    )
                `

                return {
                    stockAnterior,
                    stockNuevo,
                    diferencia,
                }
            })

            await logAuditEvent({
                empresaId,
                puntoVentaId: payload.puntoVentaId,
                usuarioId: session.usuario_id,
                accion: 'stock_ajuste_manual',
                entidad: 'item',
                entidadId: payload.itemId,
                metadata: {
                    itemNombre: item.nombre,
                    motivo: payload.motivo,
                    stockAnterior: result.stockAnterior,
                    stockNuevo: result.stockNuevo,
                    diferencia: result.diferencia,
                },
                request,
            })

            return {
                success: true,
                ...result,
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            if ((err as any)?.codigo === 'PUNTO_VENTA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'PUNTO_VENTA_FUERA_EMPRESA' })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.post('/admin/inventario/compra', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const payload = inventarioCompraSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
            await assertPuntoVentaEmpresa(empresaId, payload.puntoVentaId)

            const items = await sqlAdmin`
                SELECT i.id, i.nombre, i.maneja_stock, i.stock_actual, i.stock_minimo
                FROM items i
                WHERE i.id = ${payload.itemId}
                  AND i.empresa_id = ${empresaId}
                LIMIT 1
            `

            if (items.length === 0) {
                return reply.code(404).send({ error: 'Item no encontrado' })
            }

            const item = items[0]
            if (!item.maneja_stock) {
                return reply.code(409).send({ error: 'El item no maneja stock' })
            }

            const cantidad = Number(payload.cantidad)
            const costoTotal = payload.costoTotal !== undefined
                ? Number(payload.costoTotal)
                : Number(payload.costoUnitario ?? 0) * cantidad
            const costoUnitario = payload.costoUnitario !== undefined
                ? Number(payload.costoUnitario)
                : (cantidad > 0 ? costoTotal / cantidad : 0)

            const cajas = await sqlAdmin`
                SELECT id, abierta
                FROM cajas
                WHERE empresa_id = ${empresaId}
                  AND punto_venta_id = ${payload.puntoVentaId}
                  AND activa = true
                ORDER BY actualizado_en DESC
                LIMIT 1
            `

            const caja = cajas[0]
            if (payload.imputaCaja && (!caja || !caja.abierta)) {
                return reply.code(409).send({
                    error: 'CAJA_CERRADA_COMPRA_NO_IMPUTABLE',
                    mensaje: 'No hay caja abierta en el punto de venta para imputar la compra',
                })
            }

            const result = await sqlAdmin.begin(async (tx: any) => {
                await tx`
                    INSERT INTO items_punto_venta (
                        item_id,
                        punto_venta_id,
                        activo_en_pv,
                        stock_actual_pv,
                        stock_minimo_pv
                    )
                    VALUES (
                        ${payload.itemId},
                        ${payload.puntoVentaId},
                        true,
                        ${item.stock_actual ?? 0},
                        ${item.stock_minimo ?? 0}
                    )
                    ON CONFLICT (item_id, punto_venta_id)
                    DO NOTHING
                `

                const currentRows = await tx`
                    SELECT stock_actual_pv
                    FROM items_punto_venta
                    WHERE item_id = ${payload.itemId}
                      AND punto_venta_id = ${payload.puntoVentaId}
                    LIMIT 1
                `

                const stockAnterior = Number(currentRows[0]?.stock_actual_pv ?? 0)
                const stockNuevo = stockAnterior + cantidad

                await tx`
                    UPDATE items_punto_venta
                    SET stock_actual_pv = ${stockNuevo},
                        actualizado_en = NOW()
                    WHERE item_id = ${payload.itemId}
                      AND punto_venta_id = ${payload.puntoVentaId}
                `

                const movs = await tx`
                    INSERT INTO inventario_movimientos (
                        empresa_id,
                        punto_venta_id,
                        item_id,
                        usuario_id,
                        tipo_movimiento,
                        cantidad,
                        stock_anterior,
                        stock_nuevo,
                        costo_unitario,
                        costo_total,
                        motivo,
                        referencia_tipo,
                        metadata
                    )
                    VALUES (
                        ${empresaId},
                        ${payload.puntoVentaId},
                        ${payload.itemId},
                        ${session.usuario_id},
                        'compra_ingreso',
                        ${cantidad},
                        ${stockAnterior},
                        ${stockNuevo},
                        ${costoUnitario},
                        ${costoTotal},
                        ${payload.descripcion?.trim() || null},
                        'compra_stock',
                        ${JSON.stringify({ proveedor: payload.proveedor ?? null, referencia: payload.referencia ?? null })}::jsonb
                    )
                    RETURNING id
                `

                const inventarioMovimientoId = movs[0]?.id as string | undefined

                if (payload.imputaCaja) {
                    await tx`
                        INSERT INTO caja_movimientos (
                            empresa_id,
                            punto_venta_id,
                            caja_id,
                            usuario_id,
                            tipo,
                            categoria,
                            monto,
                            imputa_caja,
                            referencia_tipo,
                            referencia_id,
                            descripcion,
                            metadata
                        )
                        VALUES (
                            ${empresaId},
                            ${payload.puntoVentaId},
                            ${caja?.id ?? null},
                            ${session.usuario_id},
                            'egreso',
                            'compra_stock',
                            ${costoTotal},
                            true,
                            'inventario_movimiento',
                            ${inventarioMovimientoId ?? null},
                            ${payload.descripcion?.trim() || `Compra de stock: ${item.nombre}`},
                            ${JSON.stringify({ proveedor: payload.proveedor ?? null, referencia: payload.referencia ?? null })}::jsonb
                        )
                    `
                }

                return {
                    stockAnterior,
                    stockNuevo,
                    cantidad,
                    costoUnitario,
                    costoTotal,
                }
            })

            await logAuditEvent({
                empresaId,
                puntoVentaId: payload.puntoVentaId,
                usuarioId: session.usuario_id,
                accion: 'stock_compra_registrada',
                entidad: 'item',
                entidadId: payload.itemId,
                metadata: {
                    itemNombre: item.nombre,
                    cantidad: result.cantidad,
                    costoUnitario: result.costoUnitario,
                    costoTotal: result.costoTotal,
                    imputaCaja: payload.imputaCaja,
                    proveedor: payload.proveedor ?? null,
                    referencia: payload.referencia ?? null,
                },
                request,
            })

            return {
                success: true,
                ...result,
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            if ((err as any)?.codigo === 'PUNTO_VENTA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'PUNTO_VENTA_FUERA_EMPRESA' })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

    fastify.post('/admin/inventario/compra-con-alta-pv', async (request, reply) => {
        const token = request.headers.authorization?.replace('Bearer ', '')
        if (!token) return reply.code(401).send({ error: 'No autorizado' })

        const session = await authService.verifySession(token)
        if (!session) return reply.code(401).send({ error: 'Sesión inválida' })

        try {
            const payload = inventarioCompraConAltaPvSchema.parse(request.body ?? {})
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)
            await assertPuntoVentaEmpresa(empresaId, payload.puntoVentaDestinoId)

            const items = await sqlAdmin`
                SELECT i.id, i.nombre, i.categoria_id, i.precio_venta, i.orden_ui, i.maneja_stock, i.costo, i.stock_minimo, i.permite_consumo_staff
                FROM items i
                WHERE i.id = ${payload.itemId}
                  AND i.empresa_id = ${empresaId}
                LIMIT 1
            `

            if (items.length === 0) {
                return reply.code(404).send({ error: 'Item no encontrado' })
            }

            const item = items[0]
            if (!item.maneja_stock) {
                return reply.code(409).send({ error: 'El item no maneja stock' })
            }

            const alreadyInDestino = await sqlAdmin`
                SELECT id
                FROM items_punto_venta
                WHERE item_id = ${payload.itemId}
                  AND punto_venta_id = ${payload.puntoVentaDestinoId}
                LIMIT 1
            `

            if (alreadyInDestino.length > 0) {
                return reply.code(409).send({
                    error: 'ITEM_YA_EXISTE_EN_PV',
                    mensaje: 'El producto ya existe en el punto de venta destino. Usa registrar compra normal.',
                })
            }

            let config: {
                precioVentaPv: number
                costo: number
                stockMinimoPv: number
                permiteConsumoStaff: boolean
                ordenUiPv: number
                puntoVentaOrigenId?: string | null
            }

            if (payload.modoConfiguracion === 'copiar') {
                if (!payload.puntoVentaOrigenId) {
                    return reply.code(400).send({ error: 'puntoVentaOrigenId es requerido cuando modoConfiguracion = copiar' })
                }
                await assertPuntoVentaEmpresa(empresaId, payload.puntoVentaOrigenId)

                const origenRows = await sqlAdmin`
                    SELECT
                        COALESCE(ipv.precio_venta_pv, i.precio_venta) as precio_venta,
                        i.costo,
                        COALESCE(ipv.stock_minimo_pv, i.stock_minimo, 0) as stock_minimo,
                        i.permite_consumo_staff,
                        COALESCE(ipv.orden_ui_pv, i.orden_ui, 0) as orden_ui
                    FROM items i
                    JOIN items_punto_venta ipv ON ipv.item_id = i.id
                    WHERE i.id = ${payload.itemId}
                      AND i.empresa_id = ${empresaId}
                      AND ipv.punto_venta_id = ${payload.puntoVentaOrigenId}
                    LIMIT 1
                `

                if (origenRows.length === 0) {
                    return reply.code(409).send({
                        error: 'ITEM_NO_EXISTE_EN_PV_ORIGEN',
                        mensaje: 'No se encontró configuración del producto en el punto de venta origen seleccionado.',
                    })
                }

                const origen = origenRows[0]
                config = {
                    precioVentaPv: Number(origen.precio_venta ?? item.precio_venta ?? 0),
                    costo: Number(origen.costo ?? item.costo ?? 0),
                    stockMinimoPv: Number(origen.stock_minimo ?? 0),
                    permiteConsumoStaff: Boolean(origen.permite_consumo_staff ?? item.permite_consumo_staff ?? true),
                    ordenUiPv: Number(origen.orden_ui ?? item.orden_ui ?? 0),
                    puntoVentaOrigenId: payload.puntoVentaOrigenId,
                }
            } else {
                if (!payload.configuracionManual) {
                    return reply.code(400).send({ error: 'configuracionManual es requerida cuando modoConfiguracion = manual' })
                }
                config = {
                    precioVentaPv: Number(payload.configuracionManual.precioVentaPv),
                    costo: Number(payload.configuracionManual.costo),
                    stockMinimoPv: Number(payload.configuracionManual.stockMinimoPv ?? 0),
                    permiteConsumoStaff: Boolean(payload.configuracionManual.permiteConsumoStaff),
                    ordenUiPv: Number(payload.configuracionManual.ordenUiPv ?? 0),
                    puntoVentaOrigenId: null,
                }
            }

            const cantidad = Number(payload.cantidad)
            const costoTotal = payload.costoTotal !== undefined
                ? Number(payload.costoTotal)
                : Number(payload.costoUnitario ?? config.costo ?? 0) * cantidad
            const costoUnitario = payload.costoUnitario !== undefined
                ? Number(payload.costoUnitario)
                : (cantidad > 0 ? costoTotal / cantidad : 0)

            const cajas = await sqlAdmin`
                SELECT id, abierta
                FROM cajas
                WHERE empresa_id = ${empresaId}
                  AND punto_venta_id = ${payload.puntoVentaDestinoId}
                  AND activa = true
                ORDER BY actualizado_en DESC
                LIMIT 1
            `

            const caja = cajas[0]
            if (payload.imputaCaja && (!caja || !caja.abierta)) {
                return reply.code(409).send({
                    error: 'CAJA_CERRADA_COMPRA_NO_IMPUTABLE',
                    mensaje: 'No hay caja abierta en el punto de venta para imputar la compra',
                })
            }

            const result = await sqlAdmin.begin(async (tx: any) => {
                await tx`
                    INSERT INTO items_punto_venta (
                        item_id,
                        punto_venta_id,
                        activo_en_pv,
                        precio_venta_pv,
                        orden_ui_pv,
                        stock_actual_pv,
                        stock_minimo_pv
                    )
                    VALUES (
                        ${payload.itemId},
                        ${payload.puntoVentaDestinoId},
                        true,
                        ${config.precioVentaPv},
                        ${config.ordenUiPv},
                        0,
                        ${config.stockMinimoPv}
                    )
                `

                if (item.categoria_id) {
                    await tx`
                        INSERT INTO categorias_punto_venta (
                            categoria_id,
                            punto_venta_id,
                            activa_en_pv,
                            orden_ui_pv
                        )
                        VALUES (
                            ${item.categoria_id},
                            ${payload.puntoVentaDestinoId},
                            true,
                            NULL
                        )
                        ON CONFLICT (categoria_id, punto_venta_id)
                        DO UPDATE SET
                            activa_en_pv = true,
                            actualizado_en = NOW()
                    `
                }

                await tx`
                    UPDATE items
                    SET costo = ${config.costo},
                        permite_consumo_staff = ${config.permiteConsumoStaff}
                    WHERE id = ${payload.itemId}
                `

                const stockAnterior = 0
                const stockNuevo = cantidad

                await tx`
                    UPDATE items_punto_venta
                    SET stock_actual_pv = ${stockNuevo},
                        actualizado_en = NOW()
                    WHERE item_id = ${payload.itemId}
                      AND punto_venta_id = ${payload.puntoVentaDestinoId}
                `

                const movs = await tx`
                    INSERT INTO inventario_movimientos (
                        empresa_id,
                        punto_venta_id,
                        item_id,
                        usuario_id,
                        tipo_movimiento,
                        cantidad,
                        stock_anterior,
                        stock_nuevo,
                        costo_unitario,
                        costo_total,
                        motivo,
                        referencia_tipo,
                        metadata
                    )
                    VALUES (
                        ${empresaId},
                        ${payload.puntoVentaDestinoId},
                        ${payload.itemId},
                        ${session.usuario_id},
                        'compra_ingreso',
                        ${cantidad},
                        ${stockAnterior},
                        ${stockNuevo},
                        ${costoUnitario},
                        ${costoTotal},
                        ${payload.descripcion?.trim() || null},
                        'compra_stock',
                        ${JSON.stringify({ proveedor: payload.proveedor ?? null, referencia: payload.referencia ?? null, altaPvNueva: true, modoConfiguracion: payload.modoConfiguracion, puntoVentaOrigenId: config.puntoVentaOrigenId ?? null })}::jsonb
                    )
                    RETURNING id
                `

                const inventarioMovimientoId = movs[0]?.id as string | undefined

                if (payload.imputaCaja) {
                    await tx`
                        INSERT INTO caja_movimientos (
                            empresa_id,
                            punto_venta_id,
                            caja_id,
                            usuario_id,
                            tipo,
                            categoria,
                            monto,
                            imputa_caja,
                            referencia_tipo,
                            referencia_id,
                            descripcion,
                            metadata
                        )
                        VALUES (
                            ${empresaId},
                            ${payload.puntoVentaDestinoId},
                            ${caja?.id ?? null},
                            ${session.usuario_id},
                            'egreso',
                            'compra_stock',
                            ${costoTotal},
                            true,
                            'inventario_movimiento',
                            ${inventarioMovimientoId ?? null},
                            ${payload.descripcion?.trim() || `Compra de stock: ${item.nombre}`},
                            ${JSON.stringify({ proveedor: payload.proveedor ?? null, referencia: payload.referencia ?? null })}::jsonb
                        )
                    `
                }

                return {
                    stockAnterior,
                    stockNuevo,
                    cantidad,
                    costoUnitario,
                    costoTotal,
                }
            })

            await logAuditEvent({
                empresaId,
                puntoVentaId: payload.puntoVentaDestinoId,
                usuarioId: session.usuario_id,
                accion: 'catalogo_item_asignado_pv',
                entidad: 'item',
                entidadId: payload.itemId,
                metadata: {
                    itemNombre: item.nombre,
                    modoConfiguracion: payload.modoConfiguracion,
                    puntoVentaOrigenId: config.puntoVentaOrigenId ?? null,
                    precioVentaPv: config.precioVentaPv,
                    costo: config.costo,
                    stockMinimoPv: config.stockMinimoPv,
                    permiteConsumoStaff: config.permiteConsumoStaff,
                    ordenUiPv: config.ordenUiPv,
                },
                request,
            })

            await logAuditEvent({
                empresaId,
                puntoVentaId: payload.puntoVentaDestinoId,
                usuarioId: session.usuario_id,
                accion: 'stock_compra_registrada',
                entidad: 'item',
                entidadId: payload.itemId,
                metadata: {
                    itemNombre: item.nombre,
                    cantidad: result.cantidad,
                    costoUnitario: result.costoUnitario,
                    costoTotal: result.costoTotal,
                    imputaCaja: payload.imputaCaja,
                    proveedor: payload.proveedor ?? null,
                    referencia: payload.referencia ?? null,
                    altaPvNueva: true,
                    modoConfiguracion: payload.modoConfiguracion,
                },
                request,
            })

            return {
                success: true,
                altaPvNueva: true,
                ...result,
            }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Datos inválidos', details: err.errors })
            }
            if ((err as any)?.codigo === 'PUNTO_VENTA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'PUNTO_VENTA_FUERA_EMPRESA' })
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
            if (scope === 'pv' && puntoVentaId) {
                await assertPuntoVentaEmpresa(empresaId, puntoVentaId)
            }
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
            if (scope === 'pv' && puntoVentaId) {
                await assertPuntoVentaEmpresa(empresaId, puntoVentaId)
            }
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

            await reintegrarStockPorAnulacion({
                transaccionId: id,
                puntoVentaId: venta.punto_venta_id,
            })

            await logAuditEvent({
                empresaId,
                puntoVentaId: venta.punto_venta_id,
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
    fastify.get('/admin/auditoria/acciones', async (request, reply) => {
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
            const acciones = await sql<{ accion: string }[]>`
                SELECT DISTINCT accion
                FROM auditoria_eventos
                WHERE empresa_id = ${empresaId}
                ORDER BY accion ASC
            `

            return acciones.map((item) => item.accion)
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Error interno de servidor' })
        }
    })

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
            const puntoVentaId = query.puntoVentaId
            const fechaDesde = query.fechaDesde
            const fechaHasta = query.fechaHasta
            const limit = parseInt(query.limit) || 100
            const offset = parseInt(query.offset) || 0
            const empresaId = await obtenerEmpresaIdDesdeUsuario(session.usuario_id)

            if (puntoVentaId) {
                await assertPuntoVentaEmpresa(empresaId, puntoVentaId)
            }

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
                ${puntoVentaId ? sql`AND a.punto_venta_id = ${puntoVentaId}` : sql``}
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
            if ((err as any)?.codigo === 'PUNTO_VENTA_FUERA_EMPRESA') {
                return reply.code(403).send({ error: 'PUNTO_VENTA_FUERA_EMPRESA' })
            }
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
                puntoVentaId,
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
                puntoVentaId: cajas[0]?.punto_venta_id ?? null,
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

            const movimientosCaja = await sql`
                SELECT
                    COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0) as total_ingresos,
                    COALESCE(SUM(CASE WHEN tipo = 'egreso' THEN monto ELSE 0 END), 0) as total_egresos
                FROM caja_movimientos
                WHERE empresa_id = ${empresaId}
                  AND punto_venta_id = ${caja.punto_venta_id}
                  AND caja_id = ${cajaId}
                  AND imputa_caja = true
                  AND creado_en >= ${caja.fecha_apertura_actual}
            `

            const montoInicial = Number(caja.monto_inicial_actual)
            const totalEfectivo = Number(totales[0].total_efectivo)
            const totalIngresosCaja = Number(movimientosCaja[0]?.total_ingresos ?? 0)
            const totalEgresosCaja = Number(movimientosCaja[0]?.total_egresos ?? 0)
            const montoEsperado = montoInicial + totalEfectivo + totalIngresosCaja - totalEgresosCaja + (incluirFueraCajaFinal ? totalFueraCajaPendiente : 0)
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
                puntoVentaId: caja.punto_venta_id,
                usuarioId: session.usuario_id,
                accion: 'caja_cierre',
                entidad: 'caja',
                entidadId: cajaId,
                metadata: {
                    cierreId: cierre[0].id,
                    montoReal: Number(montoReal),
                    montoEsperado,
                    diferencia,
                    totalIngresosCaja,
                    totalEgresosCaja,
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
                totalIngresosCaja,
                totalEgresosCaja,
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

            const movimientosCaja = await sql`
                SELECT
                    COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0) as total_ingresos,
                    COALESCE(SUM(CASE WHEN tipo = 'egreso' THEN monto ELSE 0 END), 0) as total_egresos
                FROM caja_movimientos
                WHERE empresa_id = ${empresaId}
                  AND punto_venta_id = ${caja.punto_venta_id}
                  AND caja_id = ${cajaId}
                  AND imputa_caja = true
                  AND creado_en >= ${caja.fecha_apertura_actual}
            `

            const montoInicial = Number(caja.monto_inicial_actual)
            const totalEfectivo = Number(totales[0].total_efectivo)
            const totalIngresosCaja = Number(movimientosCaja[0]?.total_ingresos ?? 0)
            const totalEgresosCaja = Number(movimientosCaja[0]?.total_egresos ?? 0)
            const montoEsperado = montoInicial + totalEfectivo + totalIngresosCaja - totalEgresosCaja

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
                totalIngresosCaja,
                totalEgresosCaja,
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
