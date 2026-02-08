import { FastifyPluginAsync } from 'fastify'
import sql from '../db.js'

const catalogRoutes: FastifyPluginAsync = async (fastify, opts) => {
    fastify.get('/catalogo/servicios', async (request, reply) => {
        try {
            const servicios = await sql`SELECT * FROM servicios`
            return servicios
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })

    fastify.get('/catalogo/productos', async (request, reply) => {
        try {
            const productos = await sql`SELECT * FROM productos`
            return productos
        } catch (err) {
            fastify.log.error(err)
            return reply.code(500).send({ error: 'Internal Server Error' })
        }
    })
}

export default catalogRoutes
