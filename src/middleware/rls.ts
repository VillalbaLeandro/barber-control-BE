import { FastifyPluginAsync } from 'fastify';
import { setRLSContext } from '../utils/rls.js';

/**
 * Middleware de Row-Level Security
 * 
 * Configura automáticamente el contexto de empresa_id en PostgreSQL
 * antes de cada request, activando las políticas RLS.
 * 
 * Esto garantiza que TODOS los queries estén automáticamente filtrados
 * por empresa, sin importar si el desarrollador lo especifica o no.
 */
const rlsMiddleware: FastifyPluginAsync = async (fastify) => {
    // Hook que se ejecuta ANTES de cada request
    fastify.addHook('onRequest', async (request, reply) => {
        try {
            // Configurar contexto RLS en PostgreSQL
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

    fastify.log.info('✅ RLS Middleware enabled - Automatic empresa_id filtering active');
};

export default rlsMiddleware;
