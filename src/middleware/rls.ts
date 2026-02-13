import { FastifyPluginAsync } from 'fastify';
import { setRLSContext } from '../utils/rls.js';

/**
 * Middleware de Row-Level Security
 *
 * Configura el contexto de empresa_id por request para consultas que
 * usen el contexto de sesion en DB.
 */
const rlsMiddleware: FastifyPluginAsync = async (fastify) => {
    // Hook que se ejecuta ANTES de cada request
    fastify.addHook('onRequest', async (request, reply) => {
        try {
            // Lee punto_venta_id del header 'X-Punto-Venta-Id'
            const empresaId = await setRLSContext(request);

            // Guardar en request para uso posterior si es necesario
            (request as any).empresaId = empresaId;

            // Log para debugging (opcional, comentar en producción)
            fastify.log.debug(`RLS Context set: empresa_id = ${empresaId}`);

        } catch (error) {
            fastify.log.error({ err: error }, 'Error setting RLS context');
            // No bloqueamos el request, pero logueamos el error
            // En producción podrías querer bloquear aquí
        }
    });

    fastify.log.info('RLS middleware enabled - empresa_id context per request active');
};

export default rlsMiddleware;
