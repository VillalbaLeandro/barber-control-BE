import { FastifyPluginAsync } from 'fastify'
import sql from '../db.js'
import { getDefaultEmpresaId } from '../utils/empresa.js'

const posRoutes: FastifyPluginAsync = async (fastify, opts) => {
    fastify.get('/puntos-venta', async (request, reply) => {
        try {
            const empresaId = await getDefaultEmpresaId();
            const puntosVenta = await sql`
                SELECT * FROM puntos_venta 
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
