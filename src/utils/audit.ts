import type { FastifyRequest } from 'fastify'
import sql from '../db-admin.js'

type AuditInput = {
    empresaId?: string | null
    puntoVentaId?: string | null
    usuarioId?: string | null
    accion: string
    entidad?: string | null
    entidadId?: string | null
    metadata?: Record<string, unknown>
    request?: FastifyRequest
}

export async function logAuditEvent(input: AuditInput): Promise<void> {
    try {
        await sql`
            INSERT INTO auditoria_eventos (
                empresa_id,
                punto_venta_id,
                usuario_id,
                accion,
                entidad,
                entidad_id,
                metadata,
                ip,
                user_agent
            )
            VALUES (
                ${input.empresaId ?? null},
                ${input.puntoVentaId ?? null},
                ${input.usuarioId ?? null},
                ${input.accion},
                ${input.entidad ?? null},
                ${input.entidadId ?? null},
                ${JSON.stringify(input.metadata ?? {})}::jsonb,
                ${input.request?.ip ?? null},
                ${input.request?.headers?.['user-agent'] ?? null}
            )
        `
    } catch (err) {
        console.error('Error registrando auditoria:', err)
    }
}
