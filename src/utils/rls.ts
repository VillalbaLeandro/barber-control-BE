import sql from '../db.js';
import { getEmpresaIdFromRequest } from './empresa.js';
import { FastifyRequest } from 'fastify';

/**
 * Configura el empresa_id en sesión PostgreSQL como contexto operativo.
 *
 * Nota: este valor no reemplaza los filtros explícitos por empresa en queries.
 * Se usa como capa adicional y para escenarios que sí ejecuten políticas RLS.
 * 
 * @param request - Request de Fastify para obtener punto_venta_id
 * @returns Promise<string> - El empresa_id configurado
 */
export async function setRLSContext(request: FastifyRequest): Promise<string> {
    const empresaId = await getEmpresaIdFromRequest(request);

    await sql`SELECT set_config('app.current_empresa_id', ${empresaId}, false)`;

    return empresaId;
}

/**
 * Habilita bypass de RLS (solo para debugging/soporte técnico)
 * ⚠️ USAR CON EXTREMA PRECAUCIÓN
 */
export async function enableRLSBypass(): Promise<void> {
    await sql`SELECT set_config('app.bypass_rls', 'true', false)`;
}

/**
 * Deshabilita bypass de RLS
 */
export async function disableRLSBypass(): Promise<void> {
    await sql`SELECT set_config('app.bypass_rls', 'false', false)`;
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
