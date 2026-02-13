-- =====================================================
-- Migracion 018: telefono de contacto en puntos_venta
-- Fecha: 2026-02-10
-- =====================================================

BEGIN;

ALTER TABLE puntos_venta
    ADD COLUMN IF NOT EXISTS telefono_contacto VARCHAR(30);

INSERT INTO schema_migrations (filename)
VALUES ('018_puntos_venta_telefono_contacto.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
