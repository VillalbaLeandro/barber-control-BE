import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import sql from '../db.js'

const validarPinSchema = z.object({
    pin: z.string().length(4),
    staffId: z.string().uuid().optional()
})

const staffRoutes: FastifyPluginAsync = async (fastify, opts) => {
    // Listar todo el staff (público por ahora, luego admin)
    fastify.get('/staff', async (request, reply) => {
        try {
            const staff = await sql`
                SELECT id, nombre_completo as nombre, 'barber' as rol, bloqueado_hasta
                FROM usuarios
                WHERE activo = true
                ORDER BY nombre_completo ASC
            `
            return staff
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    // Rate limit por IP + staffId para frenar bots y ataques distribuidos
    fastify.post('/staff/validar-pin', {
        config: {
            rateLimit: {
                max: 5,
                timeWindow: '1 minute',
                // Combinar IP + staffId para rate limit más granular
                keyGenerator: (request) => {
                    const body = request.body as { staffId?: string }
                    const ip = request.ip
                    const staffId = body?.staffId || 'unknown'
                    return `${ip}-${staffId}`
                }
            }
        }
    }, async (request, reply) => {
        try {
            const { pin, staffId } = validarPinSchema.parse(request.body)

            // Consulta base para buscar staff (ya sea por ID o PIN)
            // Mapeamos columnas de BD a nombres usados en la app
            // pin_hash -> pin, nombre_completo -> nombre
            // Asumimos rol = 'barber' por defecto ya que no existe columna rol
            let staff;

            if (staffId) {
                const staffData = await sql`
                    SELECT id, nombre_completo as nombre, 'barber' as rol, password_hash as pin, bloqueado_hasta, intentos_fallidos
                    FROM usuarios 
                    WHERE id = ${staffId}
                `
                if (staffData.length === 0) return reply.code(404).send({ error: 'Staff no encontrado' })
                staff = staffData[0]
            } else {
                const staffData = await sql`
                    SELECT id, nombre_completo as nombre, 'barber' as rol, password_hash as pin, bloqueado_hasta, intentos_fallidos
                    FROM usuarios 
                    WHERE password_hash = ${pin}
                `
                if (staffData.length === 0) {
                    return reply.code(401).send({ error: 'PIN incorrecto' })
                }
                staff = staffData[0]
            }

            // Verificar si está bloqueado
            if (staff.bloqueado_hasta && new Date(staff.bloqueado_hasta) > new Date()) {
                return reply.code(403).send({
                    error: 'Cuenta bloqueada',
                    bloqueado_hasta: staff.bloqueado_hasta
                })
            }

            // Validar PIN (comparación directa para texto plano)
            if (staff.pin !== pin) {
                // UPDATE ATÓMICO
                // Usamos intentos_pin_fallidos (confirmado por debug script)
                const updateResult = await sql`
                    UPDATE usuarios 
                    SET intentos_fallidos = intentos_fallidos + 1,
                        bloqueado_hasta = CASE 
                            WHEN intentos_fallidos + 1 >= 5 
                            THEN NOW() + INTERVAL '15 minutes'
                            ELSE bloqueado_hasta
                        END
                    WHERE id = ${staff.id}
                    RETURNING intentos_fallidos, bloqueado_hasta
                `

                const nuevosIntentos = updateResult[0].intentos_fallidos
                const bloqueado = updateResult[0].bloqueado_hasta

                if (bloqueado && nuevosIntentos >= 5) {
                    return reply.code(403).send({
                        error: 'Cuenta bloqueada por múltiples intentos fallidos',
                        bloqueado_hasta: bloqueado
                    })
                }

                return reply.code(401).send({
                    error: 'PIN incorrecto',
                    intentos_restantes: Math.max(0, 5 - nuevosIntentos)
                })
            }

            // PIN correcto - resetear intentos
            await sql`
                UPDATE usuarios 
                SET intentos_fallidos = 0,
                    bloqueado_hasta = NULL
                WHERE id = ${staff.id}
            `

            return {
                id: staff.id,
                nombre: staff.nombre,
                rol: staff.rol
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
