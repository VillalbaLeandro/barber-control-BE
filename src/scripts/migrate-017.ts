import sql from '../db-admin.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authService } from '../services/auth.js';
import { buildPinFingerprint, isBcryptHash } from '../utils/pin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
    try {
        console.log('Iniciando migracion 017_auditoria_y_pin_fingerprint...');

        const migrationPath = path.join(__dirname, '../../migrations/017_auditoria_y_pin_fingerprint.sql');
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');
        const sqlWithoutManualTx = migrationSql
            .replace(/^\s*BEGIN;\s*$/gim, '')
            .replace(/^\s*COMMIT;\s*$/gim, '');

        await sql.begin(async (tx) => {
            await tx.unsafe(sqlWithoutManualTx);
        });

        const legacyUsers = await sql`
            SELECT id, empresa_id, pin_hash
            FROM usuarios
            WHERE pin_hash IS NOT NULL
        `;

        let migrated = 0;
        for (const user of legacyUsers) {
            const pinHash = user.pin_hash as string;
            if (!pinHash) continue;

            // Solo migrar PIN legacy en texto plano (4-6 digitos)
            if (isBcryptHash(pinHash) || !/^\d{4,6}$/.test(pinHash)) {
                continue;
            }

            const hashedPin = await authService.hashPassword(pinHash);
            const fingerprint = buildPinFingerprint(user.empresa_id, pinHash);

            await sql`
                UPDATE usuarios
                SET pin_hash = ${hashedPin},
                    pin_fingerprint = ${fingerprint},
                    actualizado_en = NOW()
                WHERE id = ${user.id}
            `;

            migrated += 1;
        }

        console.log(`Migracion 017 ejecutada. Usuarios migrados a PIN hash: ${migrated}`);
        process.exit(0);
    } catch (err) {
        console.error('Error ejecutando migracion 017:', err);
        process.exit(1);
    }
}

runMigration();
