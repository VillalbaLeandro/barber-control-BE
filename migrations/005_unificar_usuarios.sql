-- ============================================================================
-- MIGRACIÓN 005: Unificar Staff y Admin en tabla única "usuarios"
-- ============================================================================
-- ADVERTENCIA: Esta migración modifica estructura crítica.
-- ANTES DE EJECUTAR:
-- 1. Hacer BACKUP completo de la base de datos
-- 2. Revisar que no haya FKs críticas no contempladas
-- 3. Ejecutar en ambiente de testing primero
-- ============================================================================

BEGIN;

-- ============================================================================
-- FASE 1: Preparar tabla staff para convertirse en usuarios
-- ============================================================================

-- 1.1: Agregar columnas nuevas para auth dual
ALTER TABLE staff 
    ADD COLUMN IF NOT EXISTS correo VARCHAR UNIQUE,
    ADD COLUMN IF NOT EXISTS usuario VARCHAR UNIQUE,
    ADD COLUMN IF NOT EXISTS password_hash TEXT,
    ADD COLUMN IF NOT EXISTS rol_id UUID REFERENCES roles(id),
    ADD COLUMN IF NOT EXISTS ultimo_ingreso_en TIMESTAMP WITH TIME ZONE;

-- 1.2: Hacer pin_hash nullable (admins pueden no tener PIN)
ALTER TABLE staff ALTER COLUMN pin_hash DROP NOT NULL;

-- 1.3: Agregar CHECK para garantizar al menos un método de auth
ALTER TABLE staff ADD CONSTRAINT usuarios_auth_check 
    CHECK (pin_hash IS NOT NULL OR password_hash IS NOT NULL);

-- ============================================================================
-- FASE 2: Migrar datos de usuarios_admin a staff
-- ============================================================================

-- 2.1: Insertar usuarios admin en staff (ahora usuarios)
INSERT INTO staff (
    id, 
    nombre_completo, 
    correo, 
    usuario, 
    password_hash, 
    rol_id, 
    activo, 
    ultimo_ingreso_en,
    creado_en, 
    actualizado_en
)
SELECT 
    id,
    COALESCE(usuario, correo, 'admin') as nombre_completo, -- Usar usuario o email como nombre
    correo,
    usuario,
    hash_contrasena as password_hash,
    rol_id,
    activo,
    ultimo_ingreso_en,
    creado_en,
    actualizado_en
FROM usuarios_admin
WHERE id NOT IN (SELECT id FROM staff); -- Evitar duplicados si ya existen

-- ============================================================================
-- FASE 3: Actualizar FKs que apuntan a usuarios_admin
-- ============================================================================

-- IMPORTANTE: Estas columnas ahora apuntarán a staff (que será usuarios)
-- Los IDs se mantienen porque insertamos con el mismo ID

-- No necesitamos actualizar los valores (los IDs son los mismos)
-- Solo necesitamos actualizar las constraints

-- 3.1: cierres_caja.cerrada_por_admin_id
ALTER TABLE cierres_caja DROP CONSTRAINT IF EXISTS cierres_caja_cerrada_por_admin_id_fkey;
ALTER TABLE cierres_caja ADD CONSTRAINT cierres_caja_cerrada_por_usuario_id_fkey 
    FOREIGN KEY (cerrada_por_admin_id) REFERENCES staff(id);

-- 3.2: configuracion_punto_venta.actualizado_por_admin_id
ALTER TABLE configuracion_punto_venta DROP CONSTRAINT IF EXISTS configuracion_punto_venta_actualizado_por_admin_id_fkey;
ALTER TABLE configuracion_punto_venta ADD CONSTRAINT configuracion_punto_venta_actualizado_por_usuario_id_fkey 
    FOREIGN KEY (actualizado_por_admin_id) REFERENCES staff(id);

-- 3.3: consumo_staff_liquidacion.decidido_por_admin_id
ALTER TABLE consumo_staff_liquidacion DROP CONSTRAINT IF EXISTS consumo_staff_liquidacion_decidido_por_admin_id_fkey;
ALTER TABLE consumo_staff_liquidacion ADD CONSTRAINT consumo_staff_liquidacion_decidido_por_usuario_id_fkey 
    FOREIGN KEY (decidido_por_admin_id) REFERENCES staff(id);

-- 3.4: eventos_sistema.admin_id
ALTER TABLE eventos_sistema DROP CONSTRAINT IF EXISTS eventos_sistema_admin_id_fkey;
ALTER TABLE eventos_sistema ADD CONSTRAINT eventos_sistema_admin_id_fkey 
    FOREIGN KEY (admin_id) REFERENCES staff(id);

-- 3.5: transacciones.anulada_por_admin_id
ALTER TABLE transacciones DROP CONSTRAINT IF EXISTS transacciones_anulada_por_admin_id_fkey;
ALTER TABLE transacciones ADD CONSTRAINT transacciones_anulada_por_usuario_id_fkey 
    FOREIGN KEY (anulada_por_admin_id) REFERENCES staff(id);

-- ============================================================================
-- FASE 4: Migrar sesiones_admin a sesiones (unificar)
-- ============================================================================

-- 4.1: Agregar columnas a sesiones para soportar tokens (no solo PIN)
ALTER TABLE sesiones 
    ADD COLUMN IF NOT EXISTS token VARCHAR UNIQUE,
    ADD COLUMN IF NOT EXISTS expira_en TIMESTAMP WITH TIME ZONE;

-- 4.2: Hacer staff_id nullable y quitar UNIQUE (un usuario puede tener múltiples sesiones)
ALTER TABLE sesiones ALTER COLUMN staff_id DROP NOT NULL;
ALTER TABLE sesiones DROP CONSTRAINT IF EXISTS sesiones_staff_id_key;

-- 4.3: Renombrar staff_id a usuario_id para claridad
ALTER TABLE sesiones RENAME COLUMN staff_id TO usuario_id;

-- 4.4: Migrar sesiones_admin a sesiones
INSERT INTO sesiones (usuario_id, token, expira_en, creado_en)
SELECT admin_id, token, expira_en, creado_en
FROM sesiones_admin
WHERE admin_id IS NOT NULL;

-- ============================================================================
-- FASE 5: Renombrar staff → usuarios
-- ============================================================================

-- 5.1: Renombrar tabla
ALTER TABLE staff RENAME TO usuarios;

-- 5.2: Renombrar constraints que mencionan "staff"
ALTER TABLE usuarios RENAME CONSTRAINT staff_pkey TO usuarios_pkey;

-- 5.3: Actualizar FKs existentes que apuntan a "staff"
ALTER TABLE sesiones DROP CONSTRAINT IF EXISTS sesiones_staff_id_fkey;
ALTER TABLE sesiones ADD CONSTRAINT sesiones_usuario_id_fkey 
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id);

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_staff_id_fkey;
ALTER TABLE tickets RENAME COLUMN staff_id TO usuario_id;
ALTER TABLE tickets ADD CONSTRAINT tickets_usuario_id_fkey 
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id);

ALTER TABLE transacciones DROP CONSTRAINT IF EXISTS transacciones_staff_id_fkey;
ALTER TABLE transacciones RENAME COLUMN staff_id TO usuario_id;
ALTER TABLE transacciones ADD CONSTRAINT transacciones_usuario_id_fkey 
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id);

ALTER TABLE consumos_staff DROP CONSTRAINT IF EXISTS consumos_staff_staff_id_fkey;
ALTER TABLE consumos_staff RENAME COLUMN staff_id TO usuario_id;
ALTER TABLE consumos_staff ADD CONSTRAINT consumos_staff_usuario_id_fkey 
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id);

ALTER TABLE eventos_sistema DROP CONSTRAINT IF EXISTS eventos_sistema_staff_id_fkey;
ALTER TABLE eventos_sistema RENAME COLUMN staff_id TO usuario_id;
ALTER TABLE eventos_sistema ADD CONSTRAINT eventos_sistema_usuario_id_fkey 
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id);

-- ============================================================================
-- FASE 6: Limpiar tablas obsoletas
-- ============================================================================

-- 6.1: Eliminar sesiones_admin (ya migrada a sesiones)
DROP TABLE IF EXISTS sesiones_admin CASCADE;

-- 6.2: Eliminar usuarios_admin (ya migrada a usuarios)
DROP TABLE IF EXISTS usuarios_admin CASCADE;

-- ============================================================================
-- FASE 7: Crear roles por defecto si no existen
-- ============================================================================

-- Insertar roles básicos si no existen
INSERT INTO roles (nombre, descripcion)
VALUES 
    ('superadmin', 'Acceso total al sistema')
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO roles (nombre, descripcion)
VALUES 
    ('encargado', 'Puede gestionar ventas y staff')
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO roles (nombre, descripcion)
VALUES 
    ('vendedor', 'Solo puede realizar ventas')
ON CONFLICT (nombre) DO NOTHING;

-- Asignar rol por defecto a usuarios sin rol
UPDATE usuarios 
SET rol_id = (SELECT id FROM roles WHERE nombre = 'vendedor' LIMIT 1)
WHERE rol_id IS NULL;

-- Hacer rol_id NOT NULL después de asignar defaults
ALTER TABLE usuarios ALTER COLUMN rol_id SET NOT NULL;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- ============================================================================
-- Ejecutar estas queries para verificar:
--
-- SELECT COUNT(*) FROM usuarios; -- Debe ser suma de staff + admin
-- SELECT * FROM usuarios WHERE pin_hash IS NULL; -- Admins sin PIN
-- SELECT * FROM usuarios WHERE password_hash IS NULL; -- Staff sin password
-- SELECT * FROM sesiones WHERE token IS NOT NULL; -- Sesiones admin migradas
-- 
-- ============================================================================
