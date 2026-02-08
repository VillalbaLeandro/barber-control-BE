import sql from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
    try {
        console.log('🚀 Iniciando migración 003_consumos_staff...');

        // Read SQL file
        const migrationPath = path.join(__dirname, '../../migrations/003_consumos_staff.sql');
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');

        console.log('📂 Leyendo archivo SQL:', migrationPath);

        // Execute SQL
        await sql.unsafe(migrationSql);

        console.log('✅ Migración ejecutada exitosamente.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error ejecutando migración:', err);
        process.exit(1);
    }
}

runMigration();
