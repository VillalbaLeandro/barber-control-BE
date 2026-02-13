import bcrypt from 'bcryptjs'
import { randomBytes } from 'crypto'
import sqlAdmin from '../db-admin.js'

const SALT_ROUNDS = 10
const SESSION_DURATION_HOURS = 12

export const authService = {
    async hashPassword(password: string): Promise<string> {
        return bcrypt.hash(password, SALT_ROUNDS)
    },

    async verifyPassword(password: string, hash: string): Promise<boolean> {
        return bcrypt.compare(password, hash)
    },

    async createSession(usuarioId: string) {
        // Generar token seguro
        const token = randomBytes(32).toString('hex')
        const expiraEn = new Date()
        expiraEn.setHours(expiraEn.getHours() + SESSION_DURATION_HOURS)

        // Guardar en DB (tabla sesiones unificada)
        await sqlAdmin`
            INSERT INTO sesiones (usuario_id, token, expira_en)
            VALUES (${usuarioId}, ${token}, ${expiraEn})
        `

        return { token, expiraEn }
    },

    async verifySession(token: string) {
        const result = await sqlAdmin`
            SELECT 
                s.usuario_id, 
                u.nombre_completo as nombre, 
                u.correo,
                u.usuario,
                r.nombre as rol_nombre
            FROM sesiones s
            JOIN usuarios u ON s.usuario_id = u.id
            LEFT JOIN roles r ON u.rol_id = r.id
            WHERE s.token = ${token} 
            AND s.expira_en > NOW()
        `

        if (result.length === 0) return null
        return result[0]
    },

    async logout(token: string) {
        await sqlAdmin`
            DELETE FROM sesiones WHERE token = ${token}
        `
    }
}

