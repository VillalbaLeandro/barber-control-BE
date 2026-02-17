BEGIN;

CREATE TABLE IF NOT EXISTS categorias_catalogo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    nombre TEXT NOT NULL,
    nombre_normalizado TEXT NOT NULL,
    activa_base BOOLEAN NOT NULL DEFAULT true,
    orden_ui_base INTEGER NOT NULL DEFAULT 0,
    defaults_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT categorias_catalogo_nombre_check CHECK (char_length(btrim(nombre)) >= 2)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_categorias_catalogo_empresa_nombre_norm
    ON categorias_catalogo (empresa_id, nombre_normalizado);

CREATE INDEX IF NOT EXISTS idx_categorias_catalogo_empresa_activa_orden
    ON categorias_catalogo (empresa_id, activa_base, orden_ui_base, nombre);

CREATE TABLE IF NOT EXISTS categorias_punto_venta (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    categoria_id UUID NOT NULL REFERENCES categorias_catalogo(id) ON DELETE CASCADE,
    punto_venta_id UUID NOT NULL REFERENCES puntos_venta(id) ON DELETE CASCADE,
    activa_en_pv BOOLEAN NOT NULL DEFAULT true,
    orden_ui_pv INTEGER,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (categoria_id, punto_venta_id)
);

CREATE INDEX IF NOT EXISTS idx_categorias_pv_punto_venta_activa_orden
    ON categorias_punto_venta (punto_venta_id, activa_en_pv, orden_ui_pv);

CREATE INDEX IF NOT EXISTS idx_categorias_pv_categoria
    ON categorias_punto_venta (categoria_id);

ALTER TABLE items
    ADD COLUMN IF NOT EXISTS categoria_id UUID REFERENCES categorias_catalogo(id) ON DELETE SET NULL;

ALTER TABLE items
    ADD COLUMN IF NOT EXISTS tipo_cantidad TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'items_tipo_cantidad_check'
    ) THEN
        ALTER TABLE items
            ADD CONSTRAINT items_tipo_cantidad_check
            CHECK (tipo_cantidad IS NULL OR tipo_cantidad IN ('entero', 'decimal'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_items_categoria_id
    ON items (categoria_id);

INSERT INTO schema_migrations (filename)
VALUES ('025_categorias_catalogo_pv.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
