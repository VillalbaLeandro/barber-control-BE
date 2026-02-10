// Test simple para verificar que sql.begin() funciona
import sql from './db.js';

async function testTransaction() {
    try {
        console.log('🧪 Testing sql.begin() transaction...');

        const result = await sql.begin(async (sql) => {
            const [item] = await sql`SELECT 1 as test`;
            console.log('✅ Transaction works!', item);
            return item;
        });

        console.log('Result:', result);
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await sql.end();
    }
}

testTransaction();
