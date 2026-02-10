import sql from '../db.js';
import { authService } from '../services/auth.js';

async function testLogin() {
    console.log('--- Starting Debug ---');
    try {
        const email = 'admin';
        const password = 'admin123';

        console.log(`1. Searching user: ${email}`);
        const usuarios = await sql`
            SELECT id, nombre, correo as email, hash_contrasena, rol_id, activo 
            FROM usuarios_admin 
            WHERE correo = ${email} OR usuario = ${email}
        `;

        console.log(`2. Users found: ${usuarios.length}`);
        if (usuarios.length === 0) {
            console.error('User not found');
            return;
        }

        const usuario = usuarios[0];
        console.log('3. User data:', { ...usuario, hash_contrasena: 'HIDDEN' });

        console.log('4. Verifying password...');
        const isValid = await authService.verifyPassword(password, usuario.hash_contrasena);
        console.log(`5. Password valid: ${isValid}`);

        if (!isValid) {
            console.error('Invalid password');
            return;
        }

        console.log('6. Creating session...');
        const session = await authService.createSession(usuario.id);
        console.log('7. Session created:', session);

        console.log('--- Success ---');

    } catch (err) {
        console.error('--- ERROR ---');
        console.error(err);
    } finally {
        // Close DB connection to allow script to exit
        // sql.end() might not be available on postgres.js directly depending on export
        process.exit(0);
    }
}

testLogin();
