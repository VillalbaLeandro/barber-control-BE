-- =====================================================
-- Migración 015: Trigger de Descuento de Stock (Items)
-- Fecha: 2026-02-10
-- Descripción: Implementa la lógica de negocio para descontar
--   stock automáticamente cuando se registra una venta.
--   Aplica a items tipo 'producto' que tengan maneja_stock = true.
-- =====================================================

-- 1. Crear función de trigger
CREATE OR REPLACE FUNCTION update_stock_on_sale()
RETURNS TRIGGER AS $$
BEGIN
    -- Solo procesar si es un item (no null)
    IF NEW.item_id IS NOT NULL THEN
        -- Actualizar stock restando la cantidad vendida
        -- Solo si el item es producto y maneja stock
        UPDATE items_producto
        SET stock_actual = stock_actual - NEW.cantidad
        WHERE item_id = NEW.item_id
        AND maneja_stock = true;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Crear trigger en transaccion_detalles
DROP TRIGGER IF EXISTS trg_update_stock_on_sale ON transaccion_detalles;

CREATE TRIGGER trg_update_stock_on_sale
AFTER INSERT ON transaccion_detalles
FOR EACH ROW
EXECUTE FUNCTION update_stock_on_sale();

-- Nota: No necesitamos trigger para UPDATE/DELETE por ahora
-- porque las ventas son inmutables en esta fase.
