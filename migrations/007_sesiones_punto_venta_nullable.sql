-- Migración 007: Hacer punto_venta_id nullable en sesiones
-- Razón: Las sesiones de admin no tienen punto de venta asociado

BEGIN;

-- Hacer punto_venta_id nullable
ALTER TABLE sesiones 
ALTER COLUMN punto_venta_id DROP NOT NULL;

-- Agregar comentario
COMMENT ON COLUMN sesiones.punto_venta_id IS 'Punto de venta asociado (NULL para sesiones admin)';

COMMIT;
