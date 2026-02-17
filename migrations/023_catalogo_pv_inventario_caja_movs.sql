BEGIN;

CREATE TABLE IF NOT EXISTS items_punto_venta (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    punto_venta_id UUID NOT NULL REFERENCES puntos_venta(id) ON DELETE CASCADE,
    activo_en_pv BOOLEAN NOT NULL DEFAULT true,
    precio_venta_pv NUMERIC(10,2),
    orden_ui_pv INTEGER,
    stock_actual_pv NUMERIC(10,2),
    stock_minimo_pv NUMERIC(10,2),
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (item_id, punto_venta_id)
);

CREATE INDEX IF NOT EXISTS idx_items_pv_punto_venta
    ON items_punto_venta (punto_venta_id, activo_en_pv);

CREATE INDEX IF NOT EXISTS idx_items_pv_item
    ON items_punto_venta (item_id);

CREATE TABLE IF NOT EXISTS inventario_movimientos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    punto_venta_id UUID NOT NULL REFERENCES puntos_venta(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
    tipo_movimiento TEXT NOT NULL,
    cantidad NUMERIC(10,2) NOT NULL,
    stock_anterior NUMERIC(10,2),
    stock_nuevo NUMERIC(10,2),
    costo_unitario NUMERIC(10,2),
    costo_total NUMERIC(10,2),
    motivo TEXT,
    referencia_tipo TEXT,
    referencia_id UUID,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT inventario_movimientos_tipo_check CHECK (
        tipo_movimiento IN ('ajuste_manual', 'compra_ingreso', 'venta_egreso', 'anulacion_reintegro')
    )
);

CREATE INDEX IF NOT EXISTS idx_inventario_movs_empresa_pv_fecha
    ON inventario_movimientos (empresa_id, punto_venta_id, creado_en DESC);

CREATE INDEX IF NOT EXISTS idx_inventario_movs_item_fecha
    ON inventario_movimientos (item_id, creado_en DESC);

CREATE TABLE IF NOT EXISTS caja_movimientos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    punto_venta_id UUID NOT NULL REFERENCES puntos_venta(id) ON DELETE CASCADE,
    caja_id UUID REFERENCES cajas(id) ON DELETE SET NULL,
    usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
    tipo TEXT NOT NULL,
    categoria TEXT NOT NULL,
    monto NUMERIC(10,2) NOT NULL CHECK (monto >= 0),
    imputa_caja BOOLEAN NOT NULL DEFAULT true,
    referencia_tipo TEXT,
    referencia_id UUID,
    descripcion TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT caja_movimientos_tipo_check CHECK (tipo IN ('ingreso', 'egreso'))
);

CREATE INDEX IF NOT EXISTS idx_caja_movs_empresa_pv_fecha
    ON caja_movimientos (empresa_id, punto_venta_id, creado_en DESC);

CREATE INDEX IF NOT EXISTS idx_caja_movs_caja_fecha
    ON caja_movimientos (caja_id, creado_en DESC);

ALTER TABLE auditoria_eventos
    ADD COLUMN IF NOT EXISTS punto_venta_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'auditoria_eventos_punto_venta_fk'
    ) THEN
        ALTER TABLE auditoria_eventos
            ADD CONSTRAINT auditoria_eventos_punto_venta_fk
            FOREIGN KEY (punto_venta_id)
            REFERENCES puntos_venta(id)
            ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_auditoria_empresa_pv_fecha
    ON auditoria_eventos (empresa_id, punto_venta_id, creado_en DESC);

INSERT INTO items_punto_venta (
    item_id,
    punto_venta_id,
    activo_en_pv,
    precio_venta_pv,
    orden_ui_pv,
    stock_actual_pv,
    stock_minimo_pv
)
SELECT
    i.id AS item_id,
    pv.id AS punto_venta_id,
    i.activo AS activo_en_pv,
    NULL AS precio_venta_pv,
    NULL AS orden_ui_pv,
    CASE
        WHEN i.tipo = 'producto' AND COALESCE(ip.maneja_stock, false) = true THEN COALESCE(ip.stock_actual, 0)
        ELSE NULL
    END AS stock_actual_pv,
    CASE
        WHEN i.tipo = 'producto' AND COALESCE(ip.maneja_stock, false) = true THEN COALESCE(ip.stock_minimo, 0)
        ELSE NULL
    END AS stock_minimo_pv
FROM items i
JOIN puntos_venta pv ON pv.empresa_id = i.empresa_id
LEFT JOIN items_producto ip ON ip.item_id = i.id
WHERE pv.activo = true
ON CONFLICT (item_id, punto_venta_id) DO NOTHING;

INSERT INTO schema_migrations (filename)
VALUES ('023_catalogo_pv_inventario_caja_movs.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
