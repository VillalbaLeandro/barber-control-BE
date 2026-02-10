import sql from '../db.js';
import { getEmpresaIdFromRequest } from './empresa.js';
import { FastifyRequest } from 'fastify';

/**
 * Configura el empresa_id en la sesión de PostgreSQL para Row-Level Security
 * 
 * IMPORTANTE: Esta función DEBE ser llamada antes de cualquier query
 * para que las políticas RLS funcionen correctamente.
 * 
 * @param request - Request de Fastify para obtener punto_venta_id
 * @returns Promise<string> - El empresa_id configurado
 */
export async function setRLSContext(request: FastifyRequest): Promise<string> {
    const empresaId = await getEmpresaIdFromRequest(request);

    // Configurar variable de sesión en PostgreSQL
    // Esto activa las políticas RLS automáticamente
    await sql`SET LOCAL app.current_empresa_id = ${empresaId}`;

    return empresaId;
}

/**
 * Habilita bypass de RLS (solo para debugging/soporte técnico)
 * ⚠️ USAR CON EXTREMA PRECAUCIÓN
 */
export async function enableRLSBypass(): Promise<void> {
    await sql`SET LOCAL app.bypass_rls = true`;
}

/**
 * Deshabilita bypass de RLS
 */
export async function disableRLSBypass(): Promise<void> {
    await sql`SET LOCAL app.bypass_rls = false`;
}

/**
 * Verifica que RLS está funcionando correctamente
 * Útil para tests y debugging
 */
export async function verifyRLSIsolation(): Promise<{
    tabla: string;
    total_rows: number;
    empresa_actual: string;
    rows_visibles: number;
    aislamiento_ok: boolean;
}[]> {
    const result = await sql`SELECT * FROM test_rls_isolation()`;
    return result as any;
}
