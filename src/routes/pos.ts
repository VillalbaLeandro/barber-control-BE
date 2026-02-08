import { FastifyPluginAsync } from 'fastify'
import sql from '../db.js'

const posRoutes: FastifyPluginAsync = async (fastify, opts) => {
    fastify.get('/puntos-venta', async (request, reply) => {
        try {
            const puntosVenta = await sql`SELECT * FROM puntos_venta`
            return puntosVenta
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })
}

export default posRoutes
