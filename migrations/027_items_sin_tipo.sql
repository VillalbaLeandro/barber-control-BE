BEGIN;

DO $$
DECLARE
    v_combos INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_combos
    FROM items
    WHERE tipo::text = 'combo';

    IF v_combos > 0 THEN
        RAISE EXCEPTION 'No se puede migrar: existen % items combo. Deben eliminarse antes.', v_combos;
    END IF;
END $$;

DROP TRIGGER IF EXISTS validate_item_subtype_trigger ON items;
DROP TRIGGER IF EXISTS validate_combo_empresa ON combos_detalle;

DROP FUNCTION IF EXISTS validate_item_subtype();
DROP FUNCTION IF EXISTS validate_combo_misma_empresa();

DROP TRIGGER IF EXISTS trg_update_stock_on_sale ON transaccion_detalles;
DROP FUNCTION IF EXISTS update_stock_on_sale();

ALTER TABLE items
    ADD COLUMN IF NOT EXISTS costo NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS maneja_stock BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS stock_actual NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS stock_minimo NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS permite_consumo_staff BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS duracion_min INTEGER;

UPDATE items i
SET
    costo = COALESCE(p.costo, i.costo, 0),
    maneja_stock = COALESCE(p.maneja_stock, i.maneja_stock, false),
    stock_actual = COALESCE(p.stock_actual, i.stock_actual, 0),
    stock_minimo = COALESCE(p.stock_minimo, i.stock_minimo, 0),
    permite_consumo_staff = COALESCE(p.permite_consumo_staff, i.permite_consumo_staff, true)
FROM items_producto p
WHERE p.item_id = i.id;

UPDATE items i
SET duracion_min = COALESCE(s.duracion_min, i.duracion_min)
FROM items_servicio s
WHERE s.item_id = i.id;

CREATE OR REPLACE FUNCTION update_stock_on_sale()
RETURNS TRIGGER AS $$
DECLARE
    v_punto_venta_id UUID;
    v_maneja_stock BOOLEAN;
    v_stock_base NUMERIC;
    v_minimo_base NUMERIC;
    v_activo_base BOOLEAN;
BEGIN
    IF NEW.item_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT t.punto_venta_id
    INTO v_punto_venta_id
    FROM transacciones t
    WHERE t.id = NEW.transaccion_id
    LIMIT 1;

    IF v_punto_venta_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT i.maneja_stock, COALESCE(i.stock_actual, 0), COALESCE(i.stock_minimo, 0), i.activo
    INTO v_maneja_stock, v_stock_base, v_minimo_base, v_activo_base
    FROM items i
    WHERE i.id = NEW.item_id
    LIMIT 1;

    IF COALESCE(v_maneja_stock, false) = false THEN
        RETURN NEW;
    END IF;

    INSERT INTO items_punto_venta (
        item_id,
        punto_venta_id,
        activo_en_pv,
        stock_actual_pv,
        stock_minimo_pv
    )
    VALUES (
        NEW.item_id,
        v_punto_venta_id,
        COALESCE(v_activo_base, true),
        v_stock_base,
        v_minimo_base
    )
    ON CONFLICT (item_id, punto_venta_id) DO NOTHING;

    UPDATE items_punto_venta
    SET stock_actual_pv = COALESCE(stock_actual_pv, 0) - NEW.cantidad,
        actualizado_en = NOW()
    WHERE item_id = NEW.item_id
      AND punto_venta_id = v_punto_venta_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_stock_on_sale ON transaccion_detalles;
CREATE TRIGGER trg_update_stock_on_sale
AFTER INSERT ON transaccion_detalles
FOR EACH ROW
EXECUTE FUNCTION update_stock_on_sale();

DROP TABLE IF EXISTS combos_detalle;
DROP TABLE IF EXISTS items_combo;
DROP TABLE IF EXISTS items_servicio;
DROP TABLE IF EXISTS items_producto;

ALTER TABLE items
    DROP COLUMN IF EXISTS tipo;

DROP TYPE IF EXISTS item_tipo;

CREATE INDEX IF NOT EXISTS idx_items_empresa_activo_orden
    ON items (empresa_id, activo, orden_ui, nombre)
    WHERE activo = true;

INSERT INTO schema_migrations (filename)
VALUES ('027_items_sin_tipo.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
