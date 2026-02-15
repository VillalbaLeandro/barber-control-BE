import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import sql from '../db-admin.js'
import { authService } from '../services/auth.js'
import { buildPinFingerprint, isBcryptHash } from '../utils/pin.js'
import { getEmpresaIdFromRequest } from '../utils/empresa.js'
import { getOperativeConfig } from '../utils/config.js'

const validarPinSchema = z.object({
    pin: z.string().length(4),
    staffId: z.string().uuid().optional()
})

const staffRoutes: FastifyPluginAsync = async (fastify, opts) => {
    const verifyPin = async (pin: string, pinHash: string | null | undefined): Promise<boolean> => {
        if (!pinHash) return false
        if (isBcryptHash(pinHash)) {
            return authService.verifyPassword(pin, pinHash)
        }
        return pinHash === pin
    }

    // Listar todo el staff (público por ahora, luego admin)
    fastify.get('/staff', async (request, reply) => {
        try {
            const empresaId = await getEmpresaIdFromRequest(request)
            const staff = await sql`
                SELECT
                    u.id,
                    u.nombre_completo as nombre,
                    COALESCE(lower(r.nombre), 'vendedor') as rol,
                    u.bloqueado_hasta
                FROM usuarios u
                LEFT JOIN roles r ON r.id = u.rol_id
                WHERE u.activo = true
                  AND u.empresa_id = ${empresaId}
                ORDER BY u.nombre_completo ASC
            `
            return staff
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    fastify.post('/staff/validar-pin', async (request, reply) => {
        try {
            const { pin, staffId } = validarPinSchema.parse(request.body)

            // Consulta base para buscar staff (ya sea por ID o PIN)
            // Mapeamos columnas de BD a nombres usados en la app
            // pin_hash -> pin, nombre_completo -> nombre
            // Asumimos rol = 'barber' por defecto ya que no existe columna rol
            let staff;
            const empresaId = await getEmpresaIdFromRequest(request)

            const config = await getOperativeConfig(empresaId)
            const pinProtectionEnabled = config.pin.habilitar_limite_intentos
            const maxIntentos = Math.max(1, Number(config.pin.max_intentos || 5))
            const bloqueoMinutos = Math.max(1, Number(config.pin.bloqueo_minutos || 15))

            if (staffId) {
                const staffData = await sql`
                    SELECT
                        u.id,
                        u.nombre_completo as nombre,
                        COALESCE(lower(r.nombre), 'vendedor') as rol,
                        u.rol_id,
                        u.pin_hash as pin_hash,
                        u.bloqueado_hasta,
                        u.intentos_fallidos
                    FROM usuarios u
                    LEFT JOIN roles r ON r.id = u.rol_id
                    WHERE u.id = ${staffId}
                    AND u.empresa_id = ${empresaId}
                `
                if (staffData.length === 0) return reply.code(404).send({ error: 'Staff no encontrado' })
                staff = staffData[0]
            } else {
                const fingerprint = buildPinFingerprint(empresaId, pin)
                const byFingerprint = await sql`
                    SELECT
                        u.id,
                        u.nombre_completo as nombre,
                        COALESCE(lower(r.nombre), 'vendedor') as rol,
                        u.rol_id,
                        u.pin_hash as pin_hash,
                        u.bloqueado_hasta,
                        u.intentos_fallidos
                    FROM usuarios u
                    LEFT JOIN roles r ON r.id = u.rol_id
                    WHERE u.empresa_id = ${empresaId}
                    AND u.pin_fingerprint = ${fingerprint}
                    AND u.activo = true
                    LIMIT 1
                `

                if (byFingerprint.length > 0) {
                    staff = byFingerprint[0]
                } else {
                    // Fallback para usuarios legacy sin fingerprint
                    const legacyCandidates = await sql`
                        SELECT
                            u.id,
                            u.nombre_completo as nombre,
                            COALESCE(lower(r.nombre), 'vendedor') as rol,
                            u.rol_id,
                            u.pin_hash as pin_hash,
                            u.bloqueado_hasta,
                            u.intentos_fallidos
                        FROM usuarios u
                        LEFT JOIN roles r ON r.id = u.rol_id
                        WHERE u.empresa_id = ${empresaId}
                        AND u.pin_hash IS NOT NULL
                        AND u.activo = true
                    `

                    let matched: any = null
                    for (const candidate of legacyCandidates) {
                        const valid = await verifyPin(pin, candidate.pin_hash)
                        if (valid) {
                            matched = candidate
                            break
                        }
                    }

                    if (!matched) {
                        return reply.code(401).send({ error: 'PIN incorrecto' })
                    }

                    staff = matched
                }
            }

            // Verificar si está bloqueado
            if (pinProtectionEnabled && staff.bloqueado_hasta && new Date(staff.bloqueado_hasta) > new Date()) {
                return reply.code(403).send({
                    error: 'Cuenta bloqueada',
                    bloqueado_hasta: staff.bloqueado_hasta
                })
            }

            // Validar PIN (comparación directa para texto plano)
            const isPinValid = await verifyPin(pin, staff.pin_hash)
            if (!isPinValid) {
                if (!pinProtectionEnabled) {
                    return reply.code(401).send({ error: 'PIN incorrecto' })
                }

                const bloqueoInterval = `${bloqueoMinutos} minutes`
                const updateResult = await sql`
                    UPDATE usuarios 
                    SET intentos_fallidos = intentos_fallidos + 1,
                        bloqueado_hasta = CASE 
                            WHEN intentos_fallidos + 1 >= ${maxIntentos} 
                            THEN NOW() + (${bloqueoInterval})::interval
                            ELSE bloqueado_hasta
                        END
                    WHERE id = ${staff.id}
                    RETURNING intentos_fallidos, bloqueado_hasta
                `

                const nuevosIntentos = updateResult[0].intentos_fallidos
                const bloqueado = updateResult[0].bloqueado_hasta

                if (bloqueado && nuevosIntentos >= maxIntentos) {
                    return reply.code(403).send({
                        error: 'Cuenta bloqueada por múltiples intentos fallidos',
                        bloqueado_hasta: bloqueado
                    })
                }

                return reply.code(401).send({
                    error: 'PIN incorrecto',
                    intentos_restantes: Math.max(0, maxIntentos - nuevosIntentos)
                })
            }

            // PIN correcto - resetear intentos
            if (pinProtectionEnabled) {
                await sql`
                    UPDATE usuarios 
                    SET intentos_fallidos = 0,
                        bloqueado_hasta = NULL
                    WHERE id = ${staff.id}
                `
            }

            return {
                id: staff.id,
                nombre: staff.nombre,
                rol: staff.rol,
                rolId: staff.rol_id || null,
            }

        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })
}

export default staffRoutes
