BEGIN;

WITH categorias_legacy AS (
    SELECT
        empresa_id,
        btrim(categoria) AS nombre,
        lower(btrim(categoria)) AS nombre_normalizado
    FROM items
    WHERE categoria IS NOT NULL
      AND btrim(categoria) <> ''
), categorias_agrupadas AS (
    SELECT
        empresa_id,
        min(nombre) AS nombre,
        nombre_normalizado
    FROM categorias_legacy
    GROUP BY empresa_id, nombre_normalizado
)
INSERT INTO categorias_catalogo (
    empresa_id,
    nombre,
    nombre_normalizado,
    activa_base,
    orden_ui_base,
    defaults_config
)
SELECT
    empresa_id,
    nombre,
    nombre_normalizado,
    true,
    0,
    '{}'::jsonb
FROM categorias_agrupadas
ON CONFLICT (empresa_id, nombre_normalizado) DO NOTHING;

UPDATE items i
SET categoria_id = c.id
FROM categorias_catalogo c
WHERE i.empresa_id = c.empresa_id
  AND i.categoria IS NOT NULL
  AND btrim(i.categoria) <> ''
  AND lower(btrim(i.categoria)) = c.nombre_normalizado
  AND i.categoria_id IS NULL;

INSERT INTO categorias_punto_venta (
    categoria_id,
    punto_venta_id,
    activa_en_pv,
    orden_ui_pv
)
SELECT DISTINCT
    i.categoria_id,
    ipv.punto_venta_id,
    true,
    NULL::INTEGER
FROM items i
JOIN items_punto_venta ipv ON ipv.item_id = i.id
WHERE i.categoria_id IS NOT NULL
ON CONFLICT (categoria_id, punto_venta_id) DO NOTHING;

INSERT INTO schema_migrations (filename)
VALUES ('026_backfill_categorias_catalogo.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
