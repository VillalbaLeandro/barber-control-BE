-- =====================================================
-- Migración 014: Eliminar FKs legacy de transaccion_detalles
-- Fecha: 2026-02-10
-- Descripción: Elimina las restricciones de llave foránea hacia
--   productos y servicios, ya que ahora usamos la tabla items.
--   Esto permite insertar items nuevos (que no existen en tablas viejas)
--   en las columnas legacy para mantener compatibilidad de lectura
--   sin romper la integridad referencial.
-- =====================================================

-- 1. Eliminar FK hacia productos
ALTER TABLE transaccion_detalles
DROP CONSTRAINT IF EXISTS transaccion_detalles_producto_id_fkey;

-- 2. Eliminar FK hacia servicios
ALTER TABLE transaccion_detalles
DROP CONSTRAINT IF EXISTS transaccion_detalles_servicio_id_fkey;

-- 3. Opcional: Eliminar FKs de otras tablas si existen y molestan
-- Por ahora solo transaccion_detalles es crítica para ventas
