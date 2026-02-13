-- =====================================================
-- Migracion 017: auditoria + fingerprint PIN + cierres
-- Fecha: 2026-02-10
-- =====================================================

BEGIN;

CREATE TABLE IF NOT EXISTS auditoria_eventos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID REFERENCES empresas(id),
    usuario_id UUID REFERENCES usuarios(id),
    accion TEXT NOT NULL,
    entidad TEXT,
    entidad_id UUID,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip TEXT,
    user_agent TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auditoria_empresa_fecha
    ON auditoria_eventos (empresa_id, creado_en DESC);

CREATE INDEX IF NOT EXISTS idx_auditoria_accion_fecha
    ON auditoria_eventos (accion, creado_en DESC);

ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS pin_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_empresa_pin_fingerprint
    ON usuarios (empresa_id, pin_fingerprint)
    WHERE pin_fingerprint IS NOT NULL AND activo = true;

ALTER TABLE cierres_caja
    ADD COLUMN IF NOT EXISTS incluir_fuera_caja BOOLEAN,
    ADD COLUMN IF NOT EXISTS fuera_caja_incluidas INTEGER,
    ADD COLUMN IF NOT EXISTS total_fuera_caja_conciliado NUMERIC(10,2);

INSERT INTO schema_migrations (filename)
VALUES ('017_auditoria_y_pin_fingerprint.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
