export const isObject = (value: unknown): value is Record<string, unknown> => {
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
