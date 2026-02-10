-- =====================================================
-- Migración 011: Arquitectura Supertype/Subtype para Items
-- Fecha: 2026-02-09
-- Descripción: Migra de 2 tablas separadas (productos, servicios)
--              a arquitectura tabla base + tablas específicas
-- =====================================================

-- ========================================
-- PASO 1: Crear tabla base ITEMS
-- ========================================

CREATE TABLE items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo TEXT NOT NULL CHECK (tipo IN ('producto', 'servicio', 'combo')),
    nombre TEXT NOT NULL,
    categoria TEXT,
    precio_venta NUMERIC(10,2) NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT true,
    orden_ui INTEGER NOT NULL DEFAULT 0,
    empresa_id UUID NOT NULL REFERENCES empresas(id),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para items
CREATE INDEX idx_items_empresa_activo_tipo ON items(empresa_id, activo, tipo);
CREATE INDEX idx_items_tipo ON items(tipo) WHERE activo = true;
CREATE INDEX idx_items_nombre ON items(nombre) WHERE activo = true;

COMMENT ON TABLE items IS 'Tabla base para todos los items vendibles (productos, servicios, combos)';
COMMENT ON COLUMN items.tipo IS 'Discriminador de tipo: producto, servicio, combo';

-- ========================================
-- PASO 2: Crear tablas específicas
-- ========================================

-- Detalles de productos
CREATE TABLE items_producto (
    item_id UUID PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    costo NUMERIC(10,2) NOT NULL DEFAULT 0,
    maneja_stock BOOLEAN NOT NULL DEFAULT false,
    stock_actual NUMERIC(10,2) NOT NULL DEFAULT 0,
    stock_minimo NUMERIC(10,2) NOT NULL DEFAULT 0,
    permite_consumo_staff BOOLEAN NOT NULL DEFAULT true
);

COMMENT ON TABLE items_producto IS 'Detalles específicos de productos';

-- Detalles de servicios
CREATE TABLE items_servicio (
    item_id UUID PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    duracion_min INTEGER
);

COMMENT ON TABLE items_servicio IS 'Detalles específicos de servicios';

-- Detalles de combos
CREATE TABLE items_combo (
    item_id UUID PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE combos_detalle (
    combo_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES items(id),
    cantidad NUMERIC(10,2) NOT NULL DEFAULT 1,
    PRIMARY KEY (combo_id, item_id),
    CHECK (combo_id != item_id)
);

COMMENT ON TABLE items_combo IS 'Detalles específicos de combos/paquetes';
COMMENT ON TABLE combos_detalle IS 'Items incluidos en cada combo';

-- ========================================
-- PASO 3: Migrar datos existentes
-- ========================================

-- Migrar PRODUCTOS
INSERT INTO items (id, tipo, nombre, categoria, precio_venta, activo, orden_ui, empresa_id, actualizado_en)
SELECT 
    id,
    'producto' as tipo,
    nombre,
    categoria,
    precio_venta_actual as precio_venta,
    activo,
    orden_ui,
    empresa_id,
    actualizado_en
FROM productos;

INSERT INTO items_producto (item_id, costo, maneja_stock, stock_actual, stock_minimo, permite_consumo_staff)
SELECT 
    id as item_id,
    costo_actual as costo,
    maneja_stock,
    stock_actual,
    stock_minimo,
    permite_consumo_staff
FROM productos;

-- Migrar SERVICIOS
INSERT INTO items (id, tipo, nombre, categoria, precio_venta, activo, orden_ui, empresa_id, creado_en, actualizado_en)
SELECT 
    id,
    'servicio' as tipo,
    nombre,
    categoria,
    precio_actual as precio_venta,
    activo,
    orden_ui,
    empresa_id,
    creado_en,
    actualizado_en
FROM servicios;

INSERT INTO items_servicio (item_id, duracion_min)
SELECT 
    id as item_id,
    duracion_min
FROM servicios;

-- ========================================
-- PASO 4: Aplicar Row-Level Security
-- ========================================

-- Habilitar RLS en todas las tablas
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items_producto ENABLE ROW LEVEL SECURITY;
ALTER TABLE items_servicio ENABLE ROW LEVEL SECURITY;
ALTER TABLE items_combo ENABLE ROW LEVEL SECURITY;
ALTER TABLE combos_detalle ENABLE ROW LEVEL SECURITY;

-- Política para items (tabla base)
CREATE POLICY empresa_isolation ON items
    FOR ALL
    USING (empresa_id = get_current_empresa_id());

-- Política para items_producto (a través de items)
CREATE POLICY empresa_isolation ON items_producto
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM items i
            WHERE i.id = items_producto.item_id
            AND i.empresa_id = get_current_empresa_id()
        )
    );

-- Política para items_servicio (a través de items)
CREATE POLICY empresa_isolation ON items_servicio
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM items i
            WHERE i.id = items_servicio.item_id
            AND i.empresa_id = get_current_empresa_id()
        )
    );

-- Política para items_combo (a través de items)
CREATE POLICY empresa_isolation ON items_combo
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM items i
            WHERE i.id = items_combo.item_id
            AND i.empresa_id = get_current_empresa_id()
        )
    );

CREATE POLICY empresa_isolation ON combos_detalle
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM items i
            WHERE i.id = combos_detalle.combo_id
            AND i.empresa_id = get_current_empresa_id()
        )
    );

-- ========================================
-- PASO 5: Verificación de integridad
-- ========================================

-- Verificar conteos
DO $$
DECLARE
    v_productos_original INTEGER;
    v_servicios_original INTEGER;
    v_items_total INTEGER;
    v_items_producto INTEGER;
    v_items_servicio INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_productos_original FROM productos;
    SELECT COUNT(*) INTO v_servicios_original FROM servicios;
    SELECT COUNT(*) INTO v_items_total FROM items;
    SELECT COUNT(*) INTO v_items_producto FROM items WHERE tipo = 'producto';
    SELECT COUNT(*) INTO v_items_servicio FROM items WHERE tipo = 'servicio';
    
    RAISE NOTICE 'Migración completada:';
    RAISE NOTICE '  Productos originales: %', v_productos_original;
    RAISE NOTICE '  Servicios originales: %', v_servicios_original;
    RAISE NOTICE '  Items totales: %', v_items_total;
    RAISE NOTICE '  Items tipo producto: %', v_items_producto;
    RAISE NOTICE '  Items tipo servicio: %', v_items_servicio;
    
    IF v_items_producto != v_productos_original THEN
        RAISE EXCEPTION 'Error: No coinciden productos (% vs %)', v_items_producto, v_productos_original;
    END IF;
    
    IF v_items_servicio != v_servicios_original THEN
        RAISE EXCEPTION 'Error: No coinciden servicios (% vs %)', v_items_servicio, v_servicios_original;
    END IF;
    
    RAISE NOTICE '✓ Verificación de integridad exitosa';
END $$;

-- Verificar que todos tienen detalles
DO $$
DECLARE
    v_sin_detalle INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_sin_detalle
    FROM items i
    LEFT JOIN items_producto p ON i.id = p.item_id AND i.tipo = 'producto'
    LEFT JOIN items_servicio s ON i.id = s.item_id AND i.tipo = 'servicio'
    WHERE (i.tipo = 'producto' AND p.item_id IS NULL)
       OR (i.tipo = 'servicio' AND s.item_id IS NULL);
    
    IF v_sin_detalle > 0 THEN
        RAISE EXCEPTION 'Error: % items sin detalles específicos', v_sin_detalle;
    END IF;
    
    RAISE NOTICE '✓ Todos los items tienen detalles específicos';
END $$;

-- ========================================
-- PASO 6: Notas importantes
-- ========================================

-- IMPORTANTE: NO eliminar tablas viejas todavía
-- Las tablas 'productos' y 'servicios' se mantendrán temporalmente
-- para rollback en caso de problemas.
-- 
-- Para eliminarlas después de confirmar que todo funciona:
-- DROP TABLE productos CASCADE;
-- DROP TABLE servicios CASCADE;

COMMENT ON TABLE items IS 
    'Tabla base para arquitectura supertype/subtype. 
     Migrado desde productos y servicios en migración 011.
     Las tablas viejas se mantienen temporalmente para rollback.';

-- =====================================================
-- Fin de migración 011 - Supertype/Subtype
-- =====================================================
