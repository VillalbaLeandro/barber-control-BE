-- =====================================================
-- Migración 013: Items en transaccion_detalles
-- Fecha: 2026-02-09
-- Descripción: Migra transaccion_detalles para usar item_id unificado
--   en lugar de producto_id/servicio_id separados
-- =====================================================

-- ========================================
-- PASO 1: Agregar columna item_id
-- ========================================

ALTER TABLE transaccion_detalles
    ADD COLUMN item_id UUID;

COMMENT ON COLUMN transaccion_detalles.item_id IS
    'ID unificado del item (producto, servicio o combo) vendido.
     Reemplaza a producto_id y servicio_id separados.';

-- ========================================
-- PASO 2: Backfill desde producto_id/servicio_id
-- ========================================

-- Productos: item_id = producto_id
UPDATE transaccion_detalles
SET item_id = producto_id
WHERE tipo_item = 'producto'
AND producto_id IS NOT NULL;

-- Servicios: item_id = servicio_id
UPDATE transaccion_detalles
SET item_id = servicio_id
WHERE tipo_item = 'servicio'
AND servicio_id IS NOT NULL;

-- Verificar backfill
DO $$
DECLARE
    v_total INTEGER;
    v_migrados INTEGER;
    v_sin_migrar INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_total FROM transaccion_detalles;
    SELECT COUNT(*) INTO v_migrados FROM transaccion_detalles WHERE item_id IS NOT NULL;
    SELECT COUNT(*) INTO v_sin_migrar FROM transaccion_detalles WHERE item_id IS NULL;
    
    RAISE NOTICE 'Backfill completado:';
    RAISE NOTICE '  Total detalles: %', v_total;
    RAISE NOTICE '  Migrados: %', v_migrados;
    RAISE NOTICE '  Sin migrar: %', v_sin_migrar;
    
    IF v_sin_migrar > 0 THEN
        RAISE WARNING '% detalles sin item_id. Revisar datos.', v_sin_migrar;
    END IF;
END $$;

-- ========================================
-- PASO 3: Crear FK a items
-- ========================================

-- FK a tabla items
ALTER TABLE transaccion_detalles
    ADD CONSTRAINT transaccion_detalles_item_id_fkey
    FOREIGN KEY (item_id) 
    REFERENCES items(id);

COMMENT ON CONSTRAINT transaccion_detalles_item_id_fkey ON transaccion_detalles IS
    'FK a items unificado (reemplaza FKs separadas a productos/servicios)';

-- ========================================
-- PASO 4: Hacer item_id NOT NULL
-- ========================================

-- Solo si el backfill fue 100% exitoso
DO $$
DECLARE
    v_sin_migrar INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_sin_migrar 
    FROM transaccion_detalles 
    WHERE item_id IS NULL;
    
    IF v_sin_migrar = 0 THEN
        ALTER TABLE transaccion_detalles
            ALTER COLUMN item_id SET NOT NULL;
        RAISE NOTICE '✓ Columna item_id marcada como NOT NULL';
    ELSE
        RAISE EXCEPTION '% detalles sin item_id. Arreglar antes de NOT NULL.', v_sin_migrar;
    END IF;
END $$;

-- ========================================
-- PASO 5: Índice para item_id
-- ========================================

CREATE INDEX idx_transaccion_detalles_item_id 
    ON transaccion_detalles(item_id);

COMMENT ON INDEX idx_transaccion_detalles_item_id IS
    'Índice para reportes: ventas por item';

-- ========================================
-- PASO 6: Deprecar columnas viejas (COMENTADO)
-- ========================================

-- IMPORTANTE: NO eliminar todavía, dejar para rollback
-- Las columnas viejas se mantienen temporalmente
-- Descomentar después de confirmar que todo funciona:

/*
-- Eliminar FKs viejos
ALTER TABLE transaccion_detalles
    DROP CONSTRAINT IF EXISTS transaccion_detalles_producto_id_fkey,
    DROP CONSTRAINT IF EXISTS transaccion_detalles_servicio_id_fkey;

-- Deprecar columnas
ALTER TABLE transaccion_detalles
    DROP COLUMN producto_id,
    DROP COLUMN servicio_id,
    DROP COLUMN tipo_item;
*/

COMMENT ON COLUMN transaccion_detalles.producto_id IS
    'DEPRECATED: Usar item_id. Se mantiene temporalmente para rollback.';

COMMENT ON COLUMN transaccion_detalles.servicio_id IS
    'DEPRECATED: Usar item_id. Se mantiene temporalmente para rollback.';

COMMENT ON COLUMN transaccion_detalles.tipo_item IS
    'DEPRECATED: Obtener tipo desde items.tipo. Mantener por compatibilidad.';

-- ========================================
-- PASO 7: Verificación final
-- ========================================

DO $$
DECLARE
    v_total INTEGER;
    v_productos INTEGER;
    v_servicios INTEGER;
    v_con_item_id INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_total FROM transaccion_detalles;
    SELECT COUNT(*) INTO v_productos FROM transaccion_detalles WHERE tipo_item = 'producto';
    SELECT COUNT(*) INTO v_servicios FROM transaccion_detalles WHERE tipo_item = 'servicio';
    SELECT COUNT(*) INTO v_con_item_id FROM transaccion_detalles WHERE item_id IS NOT NULL;
    
    RAISE NOTICE '✓ Migración 013 completada';
    RAISE NOTICE '  Total detalles: %', v_total;
    RAISE NOTICE '  Productos: %', v_productos;
    RAISE NOTICE '  Servicios: %', v_servicios;
    RAISE NOTICE '  Con item_id: % (%.1f%%)', v_con_item_id, (v_con_item_id::float / NULLIF(v_total, 0) * 100);
    
    IF v_con_item_id = v_total THEN
        RAISE NOTICE '  ✓ 100%% de detalles migrados correctamente';
    END IF;
END $$;

-- =====================================================
-- Fin de migración 013 - Items en transaccion_detalles
-- =====================================================

-- ROADMAP:
-- 1. Ejecutar esta migración
-- 2. Actualizar backend para usar item_id
-- 3. Probar durante 1-2 semanas
-- 4. Si todo OK: descomentar PASO 6 para limpiar columnas viejas
