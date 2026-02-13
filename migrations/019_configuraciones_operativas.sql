-- =====================================================
-- Migracion 019: configuraciones operativas admin
-- Fecha: 2026-02-11
-- =====================================================

BEGIN;

CREATE TABLE IF NOT EXISTS configuraciones_operativas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    punto_venta_id UUID REFERENCES puntos_venta(id) ON DELETE CASCADE,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_config_operativa_empresa_global
    ON configuraciones_operativas (empresa_id)
    WHERE punto_venta_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_config_operativa_empresa_pv
    ON configuraciones_operativas (empresa_id, punto_venta_id)
    WHERE punto_venta_id IS NOT NULL;

INSERT INTO schema_migrations (filename)
VALUES ('019_configuraciones_operativas.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
