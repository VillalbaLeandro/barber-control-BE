BEGIN;

ALTER TABLE transacciones
    ADD COLUMN IF NOT EXISTS fuera_caja_estado TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'transacciones_fuera_caja_estado_check'
    ) THEN
        ALTER TABLE transacciones
            ADD CONSTRAINT transacciones_fuera_caja_estado_check
            CHECK (
                fuera_caja_estado IS NULL
                OR fuera_caja_estado IN ('pendiente_caja', 'imputada_caja', 'solo_balance')
            );
    END IF;
END $$;

UPDATE transacciones
SET fuera_caja_estado = 'pendiente_caja'
WHERE fuera_caja = true
  AND conciliada_en IS NULL
  AND fuera_caja_estado IS NULL;

UPDATE transacciones
SET fuera_caja_estado = 'imputada_caja'
WHERE fuera_caja = true
  AND conciliada_en IS NOT NULL
  AND fuera_caja_estado IS NULL;

CREATE INDEX IF NOT EXISTS idx_transacciones_fuera_caja_estado
    ON transacciones (empresa_id, punto_venta_id, fuera_caja, fuera_caja_estado, estado, creado_en DESC);

COMMIT;
