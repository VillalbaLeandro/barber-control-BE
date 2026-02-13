-- =====================================================
-- Migracion 016: Alineacion operativa (auth PIN + caja)
-- Fecha: 2026-02-10
-- =====================================================

BEGIN;

-- -----------------------------------------------------------------
-- 1) Tracking de migraciones (si no existe)
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------
-- 2) Auth: separar PIN de password
-- -----------------------------------------------------------------
ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS pin_hash TEXT;

-- Backfill: si password_hash no parece bcrypt, asumir que era PIN legacy
UPDATE usuarios
SET pin_hash = password_hash
WHERE pin_hash IS NULL
  AND password_hash IS NOT NULL
  AND password_hash !~ '^\$2[aby]\$';

-- Evitar repeticion de PIN por empresa (solo activos y con PIN)
CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_empresa_pin_hash
    ON usuarios (empresa_id, pin_hash)
    WHERE pin_hash IS NOT NULL AND activo = true;

COMMENT ON COLUMN usuarios.pin_hash IS
    'PIN operativo para validar ventas/consumos en POS. Separado de password_hash de admin.';

-- -----------------------------------------------------------------
-- 3) Caja: columnas faltantes requeridas por backend/admin
-- -----------------------------------------------------------------
ALTER TABLE cajas
    ADD COLUMN IF NOT EXISTS abierta BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS monto_inicial_actual NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS fecha_apertura_actual TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_cajas_abierta ON cajas(abierta);

-- -----------------------------------------------------------------
-- 4) Cierres: compatibilidad de columnas usadas por endpoints admin
-- -----------------------------------------------------------------
ALTER TABLE cierres_caja
    ADD COLUMN IF NOT EXISTS fecha_apertura TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS fecha_cierre TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS monto_inicial NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS monto_esperado NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS monto_real NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS diferencia NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS total_ventas NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS total_efectivo NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS total_tarjeta NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS total_transferencia NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS cantidad_transacciones INTEGER,
    ADD COLUMN IF NOT EXISTS observaciones TEXT,
    ADD COLUMN IF NOT EXISTS creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_cierres_fecha_cierre ON cierres_caja(fecha_cierre);

-- -----------------------------------------------------------------
-- 5) Ventas fuera de caja (para conciliacion posterior)
-- -----------------------------------------------------------------
ALTER TABLE transacciones
    ADD COLUMN IF NOT EXISTS fuera_caja BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS conciliada_en_cierre_id UUID REFERENCES cierres_caja(id),
    ADD COLUMN IF NOT EXISTS conciliada_en TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_transacciones_fuera_caja
    ON transacciones (empresa_id, fuera_caja, estado, creado_en);

INSERT INTO schema_migrations (filename)
VALUES ('016_operational_alignment.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
