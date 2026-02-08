import sql from './db.js';

async function verifySchema() {
    try {
        console.log('🔍 Checking `staff` table columns...');
        const columns = await sql`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'staff'
        `;
        console.table(columns);

        console.log('🔍 Checking staff record...');
        const staff = await sql`SELECT * FROM staff LIMIT 1`;
        console.log('Record sample:', staff[0]);

        process.exit(0);
    } catch (err) {
        console.error('❌ Error checking DB:', err);
        process.exit(1);
    }
}

verifySchema();
