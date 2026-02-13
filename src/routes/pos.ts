import { FastifyPluginAsync } from 'fastify'
import sql from '../db-admin.js'
import { obtenerEmpresaIdConPuntosVentaActivos } from '../utils/empresa.js'

const posRoutes: FastifyPluginAsync = async (fastify, opts) => {
    fastify.get('/puntos-venta', async (request, reply) => {
        try {
            const empresaId = await obtenerEmpresaIdConPuntosVentaActivos();
            const puntosVenta = await sql`
                SELECT id, nombre, codigo, direccion, telefono_contacto, activo
                FROM puntos_venta 
                WHERE empresa_id = ${empresaId} AND activo = true
                ORDER BY nombre
            `
            return puntosVenta
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })
}

export default posRoutes
