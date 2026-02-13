-- =====================================================
-- Migracion 021: control idempotente de cierre automatico
-- Fecha: 2026-02-12
-- =====================================================

BEGIN;

CREATE TABLE IF NOT EXISTS cierres_automaticos_control (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    caja_id UUID NOT NULL REFERENCES cajas(id) ON DELETE CASCADE,
    empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    punto_venta_id UUID NOT NULL REFERENCES puntos_venta(id) ON DELETE CASCADE,
    fecha_operativa DATE NOT NULL,
    hora_objetivo VARCHAR(5) NOT NULL,
    cierre_id UUID REFERENCES cierres_caja(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (caja_id, fecha_operativa, hora_objetivo)
);

CREATE INDEX IF NOT EXISTS idx_cierres_auto_empresa_fecha
    ON cierres_automaticos_control (empresa_id, fecha_operativa DESC);

INSERT INTO schema_migrations (filename)
VALUES ('021_cierre_automatico_idempotente.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
