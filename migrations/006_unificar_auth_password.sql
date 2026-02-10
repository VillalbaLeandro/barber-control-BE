-- ============================================================================
-- MIGRACIÓN 006: Unificar autenticación en password_hash
-- ============================================================================
-- Objetivo: 
--   - Eliminar pin_hash (redundante)
--   - Usar password_hash para todo (PINs numéricos o passwords alfanuméricos)
--   - Mantener flexibilidad para futuro (recovery por email, etc.)
-- ============================================================================

BEGIN;

-- ============================================================================
-- FASE 1: Migrar datos de pin_hash a password_hash
-- ============================================================================

-- 1.1: Copiar pin_hash a password_hash donde no existe
-- (Los hashes de bcrypt ya están en pin_hash, solo los movemos)
UPDATE usuarios 
SET password_hash = pin_hash 
WHERE pin_hash IS NOT NULL 
  AND password_hash IS NULL;

-- ============================================================================
-- FASE 2: Hacer password_hash obligatorio
-- ============================================================================

-- 2.1: Verificar que todos tengan password_hash
-- Si hay usuarios sin password_hash, la siguiente línea fallará (intencional)
ALTER TABLE usuarios 
    ALTER COLUMN password_hash SET NOT NULL;

-- ============================================================================
-- FASE 3: Eliminar columna pin_hash
-- ============================================================================

-- 3.1: Remover constraint de seguridad viejo (si existe)
ALTER TABLE usuarios 
    DROP CONSTRAINT IF EXISTS usuarios_auth_check;

-- 3.2: Eliminar columna pin_hash
ALTER TABLE usuarios 
    DROP COLUMN IF EXISTS pin_hash;

-- ============================================================================
-- FASE 4: Renombrar campos de seguridad para claridad
-- ============================================================================

-- 4.1: Renombrar campos relacionados a intentos fallidos
-- (Ahora sirven para password/PIN indistintamente)
ALTER TABLE usuarios 
    RENAME COLUMN intentos_pin_fallidos TO intentos_fallidos;

ALTER TABLE usuarios 
    RENAME COLUMN ultimo_intento_pin_en TO ultimo_intento_en;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- ============================================================================
-- Ejecutar para verificar:
--
-- SELECT 
--     COUNT(*) as total,
--     COUNT(password_hash) as con_password,
--     COUNT(correo) as con_email,
--     COUNT(usuario) as con_usuario
-- FROM usuarios;
--
-- SELECT column_name 
-- FROM information_schema.columns 
-- WHERE table_name = 'usuarios' 
-- ORDER BY ordinal_position;
-- ============================================================================
