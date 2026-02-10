-- 1. Insertar rol 'superadmin' si no existe
INSERT INTO roles (nombre, descripcion)
VALUES ('superadmin', 'Acceso total al sistema y configuración')
ON CONFLICT (nombre) DO NOTHING;

-- 2. Crear usuario admin por defecto (Usuario: admin / Pass: admin123)
-- El hash es un placeholder. Deberás generar uno real con tu backend o herramienta.
-- Hash de ejemplo para 'admin123' (Bcrypt): $2b$10$X7... (Generar uno válido)
WITH role_data AS (
    SELECT id FROM roles WHERE nombre = 'superadmin' LIMIT 1
)
INSERT INTO usuarios_admin (correo, usuario, hash_contrasena, rol_id, activo)
SELECT 
    'admin@sistema.com', 
    'admin', 
    '$2b$10$EpIcBjO.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0', -- REEMPLAZAR CON HASH VALIDO LUEGO
    id, 
    true
FROM role_data
WHERE NOT EXISTS (SELECT 1 FROM usuarios_admin WHERE usuario = 'admin');

-- 3. Crear tabla de sesiones para el panel admin
CREATE TABLE IF NOT EXISTS sesiones_admin (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES usuarios_admin(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expira_en TIMESTAMP WITH TIME ZONE NOT NULL,
    creado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indice para validar tokens rápido
CREATE INDEX IF NOT EXISTS idx_sesiones_admin_token ON sesiones_admin(token);
