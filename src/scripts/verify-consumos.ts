import { strict as assert } from 'assert';
import axios from 'axios';
import sql from '../db.js';

const API_URL = 'http://localhost:3001';

async function runTest() {
    try {
        console.log('🧪 Iniciando prueba de Consumos del Staff...');

        // 1. Obtener un Staff y Punto de Venta existentes
        const staff = await sql`SELECT id FROM staff LIMIT 1`;
        const puntosVenta = await sql`SELECT id FROM puntos_venta LIMIT 1`;

        if (staff.length === 0 || puntosVenta.length === 0) {
            console.error('❌ No hay staff o puntos de venta para probar.');
            process.exit(1);
        }

        const staffId = staff[0].id;
        const puntoVentaId = puntosVenta[0].id;

        console.log(`👤 Staff ID: ${staffId}`);
        console.log(`🏪 Punto Venta ID: ${puntoVentaId}`);

        // 2. Registrar Consumo
        console.log('\n📝 Registrando consumo...');
        const items = [
            {
                tipo: 'producto',
                itemId: '00000000-0000-0000-0000-000000000000', // Mock ID, endpoint doesn't validate existence strictly yet or uses mock
                nombre: 'Producto Test',
                cantidad: 1,
                precioVenta: 100,
                precioCosto: 50,
                subtotalVenta: 100,
                subtotalCosto: 50
            }
        ];

        // Need a valid UUID for item if FK constraints exist?
        // consumos_staff store items as JSONB, so itemId validation depends on logic.
        // The schema in consumos.ts validates uuid format but not existence in DB.
        // Let's generate a random UUID for the item to pass Zod
        items[0].itemId = crypto.randomUUID();

        const registroRes = await axios.post(`${API_URL}/consumos/registrar`, {
            staffId,
            puntoVentaId,
            items
        });

        assert.equal(registroRes.status, 200);
        assert.ok(registroRes.data.consumoId);
        const consumoId = registroRes.data.consumoId;
        console.log('✅ Consumo registrado ID:', consumoId);

        // 3. Listar Pendientes
        console.log('\n📋 Listando pendientes...');
        const pendientesRes = await axios.get(`${API_URL}/consumos/pendientes`, {
            params: { staffId }
        });

        assert.equal(pendientesRes.status, 200);
        const pendiente = pendientesRes.data.find((c: any) => c.consumoId === consumoId);
        assert.ok(pendiente, 'El consumo registrado debería aparecer en pendientes');
        assert.equal(pendiente.montoCobrado, undefined); // Should not have liquidation info yet
        console.log('✅ Consumo encontrado en pendientes.');

        // 4. Liquidar Consumo
        console.log('\n💰 Liquidando consumo (Cobrar)...');
        const liquidarRes = await axios.post(`${API_URL}/consumos/liquidar`, {
            consumoIds: [consumoId],
            reglaAplicada: 'precio_venta',
            motivo: 'Prueba de liquidación'
        });

        assert.equal(liquidarRes.status, 200);
        assert.equal(liquidarRes.data.liquidados, 1);
        console.log('✅ Consumo liquidado.');

        // 5. Verificar Historial
        console.log('\n📜 Verificando historial...');
        const historialRes = await axios.get(`${API_URL}/consumos/staff/${staffId}`);

        assert.equal(historialRes.status, 200);
        const historialItem = historialRes.data.find((c: any) => c.consumoId === consumoId);
        assert.ok(historialItem, 'El consumo debería aparecer en el historial');
        assert.equal(historialItem.estadoLiquidacion, 'cobrado');
        console.log('✅ Historial verificado: Estado cobrado.');

        console.log('\n🎉 ¡Todas las pruebas pasaron exitosamente!');
        process.exit(0);

    } catch (err: any) {
        console.error('❌ Falló la prueba:', err.response?.data || err.message);
        process.exit(1);
    }
}

runTest();
