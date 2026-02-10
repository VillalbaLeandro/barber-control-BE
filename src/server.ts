import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import 'dotenv/config'
import sql from './db.js'

import catalogRoutes from './routes/catalog.js'
import posRoutes from './routes/pos.js'
import salesRoutes from './routes/sales.js'
import staffRoutes from './routes/staff.js'
import ticketRoutes from './routes/tickets.js'
import sessionRoutes from './routes/session.js'
import consumosRoutes from './routes/consumos.js'
import adminRoutes from './routes/admin.js'
import rlsMiddleware from './middleware/rls.js'

const fastify = Fastify({
    logger: true
})

// Register plugins
await fastify.register(cors, {
    origin: true // Allow all origins for now
})

await fastify.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute'
})

// 🔒 Register RLS Middleware - CRITICAL FOR SECURITY
// This MUST be registered before routes to ensure all queries are filtered by empresa_id
await fastify.register(rlsMiddleware)

// Register routes
await fastify.register(posRoutes)
await fastify.register(catalogRoutes)
await fastify.register(staffRoutes)
await fastify.register(salesRoutes)
await fastify.register(ticketRoutes)
await fastify.register(sessionRoutes)
await fastify.register(consumosRoutes)
await fastify.register(adminRoutes)

// Health check route
fastify.get('/', async (request, reply) => {
    try {
        const result = await sql`SELECT 1 as connected`
        return { status: 'ok', database: result[0].connected === 1 ? 'connected' : 'error' }
    } catch (err) {
        fastify.log.error(err)
        return { status: 'error', message: 'Database connection failed' }
    }
})

// Start server
const start = async () => {
    try {
        const port = parseInt(process.env.PORT || '3000')
        await fastify.listen({ port, host: '0.0.0.0' })
        console.log(`Server listening on port ${port}`)
    } catch (err) {
        fastify.log.error(err)
        process.exit(1)
    }
}

start()
