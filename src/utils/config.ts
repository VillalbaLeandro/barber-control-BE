import sql from '../db-admin.js'
import { deepMerge, normalizeConfigInput } from './config-helpers.js'

export { deepMerge, normalizeConfigInput }

export type OperativeConfig = {
    regional: {
        timezone: string
    }
    pin: {
        habilitar_limite_intentos: boolean
        max_intentos: number
        bloqueo_minutos: number
        mostrar_contador_intentos: boolean
    }
    caja: {
        cierre_automatico_habilitado: boolean
        cierre_automatico_hora: string | null
        apertura_modo: 'manual' | 'primera_venta' | 'hora_programada'
        apertura_hora: string | null
        apertura_roles_permitidos: string[]
        accion_caja_cerrada: 'preguntar' | 'fuera_caja' | 'bloquear'
        permitir_ventas_fuera_caja: boolean
        manejo_fuera_caja_al_cerrar: 'preguntar' | 'incluir' | 'excluir'
    }
    consumos: {
        al_cierre_sin_liquidar: 'pendiente_siguiente_caja' | 'cobro_automatico_venta' | 'cobro_automatico_costo' | 'perdonado' | 'no_permitir_cierre'
    }
}

export const DEFAULT_OPERATIVE_CONFIG: OperativeConfig = {
    regional: {
        timezone: 'America/Argentina/Buenos_Aires',
    },
    pin: {
        habilitar_limite_intentos: false,
        max_intentos: 5,
        bloqueo_minutos: 15,
        mostrar_contador_intentos: false,
    },
    caja: {
        cierre_automatico_habilitado: false,
        cierre_automatico_hora: null,
        apertura_modo: 'manual',
        apertura_hora: null,
        apertura_roles_permitidos: [],
        accion_caja_cerrada: 'preguntar',
        permitir_ventas_fuera_caja: true,
        manejo_fuera_caja_al_cerrar: 'preguntar',
    },
    consumos: {
        al_cierre_sin_liquidar: 'pendiente_siguiente_caja',
    },
}

export async function getOperativeConfig(empresaId: string, puntoVentaId?: string | null): Promise<OperativeConfig> {
    try {
        const [globalConfig] = await sql`
            SELECT config
            FROM configuraciones_operativas
            WHERE empresa_id = ${empresaId}
            AND punto_venta_id IS NULL
            LIMIT 1
        `

        let merged = deepMerge(DEFAULT_OPERATIVE_CONFIG, normalizeConfigInput(globalConfig?.config))

        if (puntoVentaId) {
            const [pointConfig] = await sql`
                SELECT config
                FROM configuraciones_operativas
                WHERE empresa_id = ${empresaId}
                AND punto_venta_id = ${puntoVentaId}
                LIMIT 1
            `
            merged = deepMerge(merged, normalizeConfigInput(pointConfig?.config))
        }

        return merged
    } catch {
        return DEFAULT_OPERATIVE_CONFIG
    }
}
