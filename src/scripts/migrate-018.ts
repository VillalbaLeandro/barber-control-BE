import sql from '../db-admin.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
    try {
        console.log('Iniciando migracion 018_puntos_venta_telefono_contacto...');

        const migrationPath = path.join(__dirname, '../../migrations/018_puntos_venta_telefono_contacto.sql');
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');
        const sqlWithoutManualTx = migrationSql
            .replace(/^\s*BEGIN;\s*$/gim, '')
            .replace(/^\s*COMMIT;\s*$/gim, '');

        await sql.begin(async (tx) => {
            await tx.unsafe(sqlWithoutManualTx);
        });

        console.log('Migracion 018 ejecutada exitosamente.');
        process.exit(0);
    } catch (err) {
        console.error('Error ejecutando migracion 018:', err);
        process.exit(1);
    }
}

runMigration();
