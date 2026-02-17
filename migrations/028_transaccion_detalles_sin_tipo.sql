BEGIN;

ALTER TABLE transaccion_detalles
    ALTER COLUMN tipo_item DROP NOT NULL;

ALTER TABLE transaccion_detalles
    DROP CONSTRAINT IF EXISTS transaccion_detalles_tipo_item_check;

ALTER TABLE transaccion_detalles
    DROP CONSTRAINT IF EXISTS transaccion_detalles_check;

COMMENT ON COLUMN transaccion_detalles.tipo_item IS 'LEGACY: ya no se usa para validar detalle. Usar item_id.';
COMMENT ON COLUMN transaccion_detalles.servicio_id IS 'LEGACY: usar item_id.';
COMMENT ON COLUMN transaccion_detalles.producto_id IS 'LEGACY: usar item_id.';

INSERT INTO schema_migrations (filename)
VALUES ('028_transaccion_detalles_sin_tipo.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
