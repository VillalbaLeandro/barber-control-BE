import sql from '../db-admin.js'

export type OperativeConfig = {
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
    }
    consumos: {
        al_cierre_sin_liquidar: 'pendiente_siguiente_caja' | 'cobro_automatico_venta' | 'cobro_automatico_costo' | 'perdonado'
    }
}

export const DEFAULT_OPERATIVE_CONFIG: OperativeConfig = {
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
    },
    consumos: {
        al_cierre_sin_liquidar: 'pendiente_siguiente_caja',
    },
}

const isObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const normalizeConfigInput = (value: unknown): Record<string, unknown> => {
    if (isObject(value)) return value

    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value)
            if (isObject(parsed)) return parsed
        } catch {
            return {}
        }
    }

    return {}
}

export const deepMerge = <T>(base: T, override: unknown): T => {
    if (!isObject(base)) {
        return base
    }

    const normalizedOverride = normalizeConfigInput(override)
    if (!isObject(normalizedOverride)) {
        return base
    }

    const result: Record<string, unknown> = { ...base }
    for (const key of Object.keys(normalizedOverride)) {
        const baseValue = (base as Record<string, unknown>)[key]
        const overrideValue = normalizedOverride[key]

        if (isObject(baseValue) && isObject(overrideValue)) {
            result[key] = deepMerge(baseValue, overrideValue)
        } else if (overrideValue !== undefined) {
            result[key] = overrideValue
        }
    }

    return result as T
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
