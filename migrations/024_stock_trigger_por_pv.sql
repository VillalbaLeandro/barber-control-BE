BEGIN;

CREATE OR REPLACE FUNCTION update_stock_on_sale()
RETURNS TRIGGER AS $$
DECLARE
    v_punto_venta_id UUID;
    v_maneja_stock BOOLEAN;
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

    SELECT p.maneja_stock
    INTO v_maneja_stock
    FROM items_producto p
    WHERE p.item_id = NEW.item_id
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
    SELECT
        i.id,
        v_punto_venta_id,
        i.activo,
        COALESCE(ip.stock_actual, 0),
        COALESCE(ip.stock_minimo, 0)
    FROM items i
    JOIN items_producto ip ON ip.item_id = i.id
    WHERE i.id = NEW.item_id
    ON CONFLICT (item_id, punto_venta_id) DO NOTHING;

    UPDATE items_punto_venta
    SET stock_actual_pv = COALESCE(stock_actual_pv, 0) - NEW.cantidad,
        actualizado_en = NOW()
    WHERE item_id = NEW.item_id
      AND punto_venta_id = v_punto_venta_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (filename)
VALUES ('024_stock_trigger_por_pv.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
