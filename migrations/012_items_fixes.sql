-- =====================================================
-- Migración 012: Correcciones Items Supertype/Subtype
-- Fecha: 2026-02-09
-- Descripción: Aplica correcciones a migración 011:
--   1. ENUM para tipo
--   2. Constraint trigger DEFERRABLE
--   3. FK correcto en combos_detalle
--   4. Trigger para combos misma empresa
--   5. RLS con WITH CHECK
--   6. Índices optimizados
-- =====================================================

-- ========================================
-- PASO 1: Crear ENUM para tipo
-- ========================================

-- Eliminar CHECK constraint de migración 011 (usa TEXT)
ALTER TABLE items
    DROP CONSTRAINT IF EXISTS items_tipo_check;

-- Crear ENUM
CREATE TYPE item_tipo AS ENUM ('producto', 'servicio', 'combo');

-- Convertir columna TEXT a ENUM
ALTER TABLE items
    ALTER COLUMN tipo TYPE item_tipo USING tipo::item_tipo;

COMMENT ON TYPE item_tipo IS 'Tipos de items vendibles: producto, servicio, combo';

-- ========================================
-- PASO 2: Constraint Trigger DEFERRABLE
-- ========================================

-- Función para validar que el subtipo existe
CREATE OR REPLACE FUNCTION validate_item_subtype()
RETURNS TRIGGER AS $$
BEGIN
    -- Validar que existe el registro correspondiente en la tabla hija
    IF NEW.tipo = 'producto'::item_tipo THEN
        IF NOT EXISTS (SELECT 1 FROM items_producto WHERE item_id = NEW.id) THEN
            RAISE EXCEPTION 'Item de tipo producto debe tener registro en items_producto (id: %)', NEW.id;
        END IF;
    ELSIF NEW.tipo = 'servicio'::item_tipo THEN
        IF NOT EXISTS (SELECT 1 FROM items_servicio WHERE item_id = NEW.id) THEN
            RAISE EXCEPTION 'Item de tipo servicio debe tener registro en items_servicio (id: %)', NEW.id;
        END IF;
    ELSIF NEW.tipo = 'combo'::item_tipo THEN
        IF NOT EXISTS (SELECT 1 FROM items_combo WHERE item_id = NEW.id) THEN
            RAISE EXCEPTION 'Item de tipo combo debe tener registro en items_combo (id: %)', NEW.id;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger DEFERRABLE para permitir INSERT en orden flexible
CREATE CONSTRAINT TRIGGER validate_item_subtype_trigger
    AFTER INSERT OR UPDATE ON items
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION validate_item_subtype();

COMMENT ON FUNCTION validate_item_subtype() IS 
    'Valida que cada item tenga su registro correspondiente en la tabla subtipo.
     Se ejecuta al final de la transacción (DEFERRABLE) para permitir INSERT flexible.';

-- ========================================
-- PASO 3: Corregir FK en combos_detalle
-- ========================================

-- Eliminar constraint viejo
ALTER TABLE combos_detalle
    DROP CONSTRAINT combos_detalle_combo_id_fkey;

-- Agregar constraint correcto: apunta a items_combo
ALTER TABLE combos_detalle
    ADD CONSTRAINT combos_detalle_combo_id_fkey
    FOREIGN KEY (combo_id) 
    REFERENCES items_combo(item_id) 
    ON DELETE CASCADE;

COMMENT ON CONSTRAINT combos_detalle_combo_id_fkey ON combos_detalle IS
    'FK a items_combo garantiza que combo_id siempre sea un combo válido';

-- ========================================
-- PASO 4: Trigger para combos misma empresa
-- ========================================

-- Función para validar que items del combo sean de la misma empresa
CREATE OR REPLACE FUNCTION validate_combo_misma_empresa()
RETURNS TRIGGER AS $$
DECLARE
    v_combo_empresa_id UUID;
    v_item_empresa_id UUID;
BEGIN
    -- Obtener empresa_id del combo
    SELECT empresa_id INTO v_combo_empresa_id 
    FROM items 
    WHERE id = NEW.combo_id;
    
    -- Obtener empresa_id del item
    SELECT empresa_id INTO v_item_empresa_id 
    FROM items 
    WHERE id = NEW.item_id;
    
    -- Validar que sean de la misma empresa
    IF v_combo_empresa_id != v_item_empresa_id THEN
        RAISE EXCEPTION 'No se pueden mezclar items de diferentes empresas en un combo (combo: %, item: %)', 
            v_combo_empresa_id, v_item_empresa_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para validar antes de INSERT/UPDATE
CREATE TRIGGER validate_combo_empresa
    BEFORE INSERT OR UPDATE ON combos_detalle
    FOR EACH ROW
    EXECUTE FUNCTION validate_combo_misma_empresa();

COMMENT ON FUNCTION validate_combo_misma_empresa() IS
    'Evita que un combo incluya items de otra empresa (seguridad adicional a RLS)';

-- ========================================
-- PASO 5: Actualizar RLS con WITH CHECK
-- ========================================

-- Eliminar políticas viejas (solo USING)
DROP POLICY IF EXISTS empresa_isolation ON items;
DROP POLICY IF EXISTS empresa_isolation ON items_producto;
DROP POLICY IF EXISTS empresa_isolation ON items_servicio;
DROP POLICY IF EXISTS empresa_isolation ON items_combo;
DROP POLICY IF EXISTS empresa_isolation ON combos_detalle;

-- Recrear con USING + WITH CHECK

-- Items (tabla base)
CREATE POLICY empresa_isolation ON items
    FOR ALL
    USING (empresa_id = get_current_empresa_id())
    WITH CHECK (empresa_id = get_current_empresa_id());

-- Items producto
CREATE POLICY empresa_isolation ON items_producto
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM items i
            WHERE i.id = items_producto.item_id
            AND i.empresa_id = get_current_empresa_id()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM items i
            WHERE i.id = items_producto.item_id
            AND i.empresa_id = get_current_empresa_id()
        )
    );

-- Items servicio
CREATE POLICY empresa_isolation ON items_servicio
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM items i
            WHERE i.id = items_servicio.item_id
            AND i.empresa_id = get_current_empresa_id()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM items i
            WHERE i.id = items_servicio.item_id
            AND i.empresa_id = get_current_empresa_id()
        )
    );

-- Items combo
CREATE POLICY empresa_isolation ON items_combo
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM items i
            WHERE i.id = items_combo.item_id
            AND i.empresa_id = get_current_empresa_id()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM items i
            WHERE i.id = items_combo.item_id
            AND i.empresa_id = get_current_empresa_id()
        )
    );

-- Combos detalle (validar tanto combo como item)
CREATE POLICY empresa_isolation ON combos_detalle
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM items ic
            WHERE ic.id = combos_detalle.combo_id
            AND ic.empresa_id = get_current_empresa_id()
        )
        AND EXISTS (
            SELECT 1 FROM items ii
            WHERE ii.id = combos_detalle.item_id
            AND ii.empresa_id = get_current_empresa_id()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM items ic
            WHERE ic.id = combos_detalle.combo_id
            AND ic.empresa_id = get_current_empresa_id()
        )
        AND EXISTS (
            SELECT 1 FROM items ii
            WHERE ii.id = combos_detalle.item_id
            AND ii.empresa_id = get_current_empresa_id()
        )
    );

COMMENT ON POLICY empresa_isolation ON items IS
    'RLS con USING y WITH CHECK: bloquea lectura y escritura cross-empresa';

-- ========================================
-- PASO 6: Índices optimizados
-- ========================================

-- Eliminar índices subóptimos
DROP INDEX IF EXISTS idx_items_tipo;
DROP INDEX IF EXISTS idx_items_nombre;

-- Índice para listados UI (empresa + activo + orden)
CREATE INDEX idx_items_empresa_activo_orden 
    ON items(empresa_id, activo, orden_ui, nombre)
    WHERE activo = true;

-- Índice para búsqueda ILIKE eficiente (pg_trgm)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_items_nombre_trgm 
    ON items USING GIN (nombre gin_trgm_ops);

CREATE INDEX idx_items_categoria_trgm 
    ON items USING GIN (categoria gin_trgm_ops)
    WHERE categoria IS NOT NULL;

COMMENT ON INDEX idx_items_empresa_activo_orden IS
    'Índice optimizado para queries UI: empresa → activos → ordenados';

COMMENT ON INDEX idx_items_nombre_trgm IS
    'Índice trigram (pg_trgm) para búsqueda rápida ILIKE en nombre';

-- ========================================
-- PASO 7: Index para items por tipo
-- ========================================

-- Índice parcial por tipo (útil para /items?tipo=producto)
CREATE INDEX idx_items_tipo_producto 
    ON items(empresa_id, activo)
    WHERE tipo = 'producto'::item_tipo;

CREATE INDEX idx_items_tipo_servicio 
    ON items(empresa_id, activo)
    WHERE tipo = 'servicio'::item_tipo;

CREATE INDEX idx_items_tipo_combo 
    ON items(empresa_id, activo)
    WHERE tipo = 'combo'::item_tipo;

-- ========================================
-- PASO 8: Verificación
-- ========================================

DO $$
DECLARE
    v_items_sin_subtipo INTEGER;
BEGIN
    -- Verificar que todos los items tienen subtipo
    SELECT COUNT(*) INTO v_items_sin_subtipo
    FROM items i
    LEFT JOIN items_producto p ON i.id = p.item_id AND i.tipo = 'producto'::item_tipo
    LEFT JOIN items_servicio s ON i.id = s.item_id AND i.tipo = 'servicio'::item_tipo
    LEFT JOIN items_combo c ON i.id = c.item_id AND i.tipo = 'combo'::item_tipo
    WHERE (i.tipo = 'producto'::item_tipo AND p.item_id IS NULL)
       OR (i.tipo = 'servicio'::item_tipo AND s.item_id IS NULL)
       OR (i.tipo = 'combo'::item_tipo AND c.item_id IS NULL);
    
    IF v_items_sin_subtipo > 0 THEN
        RAISE EXCEPTION '% items sin subtipo correspondiente', v_items_sin_subtipo;
    END IF;
    
    RAISE NOTICE '✓ Migración 012 completada exitosamente';
    RAISE NOTICE '  - ENUM item_tipo creado';
    RAISE NOTICE '  - Constraint trigger DEFERRABLE activo';
    RAISE NOTICE '  - FK de combos_detalle corregido';
    RAISE NOTICE '  - Trigger cross-empresa en combos activo';
    RAISE NOTICE '  - RLS con WITH CHECK actualizado';
    RAISE NOTICE '  - Índices optimizados (pg_trgm)';
END $$;

-- =====================================================
-- Fin de migración 012 - Correcciones Items
-- =====================================================
