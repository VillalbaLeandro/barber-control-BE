import { createHash, randomInt } from 'crypto'

export function buildPinFingerprint(empresaId: string, pin: string): string {
    return createHash('sha256').update(`${empresaId}:${pin}`).digest('hex')
}

export function generatePin4(): string {
    return randomInt(0, 10000).toString().padStart(4, '0')
}

export function isBcryptHash(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.startsWith('$2')
}
