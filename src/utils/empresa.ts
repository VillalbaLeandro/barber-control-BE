import sql from '../db.js';
import { FastifyRequest } from 'fastify';

/**
 * Obtiene el ID de la empresa por defecto (la primera en la tabla)
 * Usado como fallback cuando no hay punto de venta especificado
 */
export async function getDefaultEmpresaId(): Promise<string> {
    const result = await sql`SELECT id FROM empresas LIMIT 1`;
    if (result.length === 0) {
        throw new Error('No hay empresas configuradas en el sistema');
    }
    return result[0].id;
}

/**
 * Obtiene el ID de la empresa desde el punto de venta del request
 * 
 * Flujo:
 * 1. Frontend envía 'X-Punto-Venta-Id' en headers
 * 2. Consulta la tabla puntos_venta para obtener empresa_id
 * 3. Si no hay header, usa empresa por defecto
 * 
 * @param request - Request de Fastify
 * @returns empresa_id asociado al punto de venta
 */
export async function getEmpresaIdFromRequest(request: FastifyRequest): Promise<string> {
    // Intentar obtener punto_venta_id desde headers
    const puntoVentaId = request.headers['x-punto-venta-id'] as string | undefined;

    if (puntoVentaId) {
        try {
            // Consultar empresa_id del punto de venta
            const result = await sql`
                SELECT empresa_id 
                FROM puntos_venta 
                WHERE id = ${puntoVentaId}
                AND activo = true
                LIMIT 1
            `;

            if (result.length > 0) {
                return result[0].empresa_id;
            }

            // Si no se encuentra el punto de venta, usar default
            console.warn(`⚠️ Punto de venta ${puntoVentaId} no encontrado, usando empresa por defecto`);
        } catch (error) {
            console.error('Error obteniendo empresa_id desde punto de venta:', error);
        }
    }

    // Fallback: usar empresa por defecto
    return getDefaultEmpresaId();
}
