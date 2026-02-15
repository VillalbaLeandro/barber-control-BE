import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import sql from '../db-admin.js'
import { intentarCierreAutomaticoPuntoVenta } from '../utils/operativa-runtime.js'

const setPuntoVentaSchema = z.object({
    staffId: z.string().uuid(),
    puntoVentaId: z.string().uuid()
})

const sessionRoutes: FastifyPluginAsync = async (fastify, opts) => {
    // Establecer punto de venta activo para la sesión
    fastify.post('/session/punto-venta', async (request, reply) => {
        try {
            console.log('🚀 Estableciendo sesión punto venta:', request.body);
            const { staffId, puntoVentaId } = setPuntoVentaSchema.parse(request.body)

            // Verificar que el staff existe
            // Corrección Schema: nombre -> nombre_completo, rol -> 'barber' (default)
            const staff = await sql`
                SELECT id, nombre_completo as nombre, 'barber' as rol FROM usuarios WHERE id = ${staffId}
            `

            if (staff.length === 0) {
                console.warn('❌ Staff no encontrado:', staffId);
                return reply.code(404).send({ error: 'Staff no encontrado' })
            }

            // Verificar que el punto de venta existe y está activo
            const puntoVenta = await sql`
                SELECT id, nombre, codigo, direccion, telefono_contacto, activo 
                FROM puntos_venta 
                WHERE id = ${puntoVentaId}
            `

            if (puntoVenta.length === 0) {
                console.warn('❌ Punto de venta no encontrado:', puntoVentaId);
                return reply.code(404).send({ error: 'Punto de venta no encontrado' })
            }

            if (!puntoVenta[0].activo) {
                console.warn('❌ Punto de venta inactivo:', puntoVenta[0].nombre);
                return reply.code(400).send({ error: 'Punto de venta inactivo' })
            }

            try {
                await intentarCierreAutomaticoPuntoVenta({
                    puntoVentaId,
                    request,
                    motivo: 'session_punto_venta',
                })
            } catch (error) {
                fastify.log.warn({ error, puntoVentaId }, 'No se pudo intentar cierre automático al seleccionar punto de venta')
            }

            // Registrar sesión (opcional - para auditoría)
            // Primero cerrar sesiones anteriores del usuario
            await sql`
                UPDATE sesiones
                SET fin_sesion = NOW()
                WHERE usuario_id = ${staffId} AND fin_sesion IS NULL
            `

            // Crear nueva sesión
            await sql`
                INSERT INTO sesiones (usuario_id, punto_venta_id, inicio_sesion)
                VALUES (${staffId}, ${puntoVentaId}, NOW())
            `

            console.log('✅ Sesión establecida para:', staff[0].nombre);

            return {
                success: true,
                session: {
                    staffId: staff[0].id,
                    staffNombre: staff[0].nombre,
                    staffRol: staff[0].rol,
                    puntoVentaId: puntoVenta[0].id,
                    puntoVentaNombre: puntoVenta[0].nombre,
                    puntoVentaCodigo: puntoVenta[0].codigo,
                    puntoVentaDireccion: puntoVenta[0].direccion,
                    puntoVentaTelefono: puntoVenta[0].telefono_contacto
                }
            }
        } catch (err) {
            console.error('💥 Error en session/punto-venta:', err);
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    // Cerrar sesión
    fastify.post('/session/cerrar', async (request, reply) => {
        try {
            const { staffId } = z.object({ staffId: z.string().uuid() }).parse(request.body)

            await sql`
                UPDATE sesiones
                SET fin_sesion = NOW()
                WHERE usuario_id = ${staffId} AND fin_sesion IS NULL
            `

            return { success: true }
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Validation Error', details: err.errors })
            }
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    // Obtener sesión activa
    fastify.get('/session/:staffId', async (request, reply) => {
        try {
            const { staffId } = request.params as { staffId: string }

            // Corrección Schema: st.nombre -> st.nombre_completo, st.rol -> 'barber'
            const sesion = await sql`
                SELECT s.usuario_id, st.nombre_completo as staff_nombre, 'barber' as staff_rol,
                       s.punto_venta_id, pv.nombre as punto_venta_nombre, pv.codigo as punto_venta_codigo,
                       pv.direccion as punto_venta_direccion, pv.telefono_contacto as punto_venta_telefono,
                       s.inicio_sesion
                FROM sesiones s
                JOIN usuarios st ON s.usuario_id = st.id
                JOIN puntos_venta pv ON s.punto_venta_id = pv.id
                WHERE s.usuario_id = ${staffId} AND s.fin_sesion IS NULL
                ORDER BY s.inicio_sesion DESC
                LIMIT 1
            `

            if (sesion.length === 0) {
                return reply.code(404).send({ error: 'No hay sesión activa' })
            }

            return {
                staffId: sesion[0].usuario_id,
                staffNombre: sesion[0].staff_nombre,
                staffRol: sesion[0].staff_rol,
                puntoVentaId: sesion[0].punto_venta_id,
                puntoVentaNombre: sesion[0].punto_venta_nombre,
                puntoVentaCodigo: sesion[0].punto_venta_codigo,
                puntoVentaDireccion: sesion[0].punto_venta_direccion,
                puntoVentaTelefono: sesion[0].punto_venta_telefono,
                inicioSesion: sesion[0].inicio_sesion
            }
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })
}

export default sessionRoutes
