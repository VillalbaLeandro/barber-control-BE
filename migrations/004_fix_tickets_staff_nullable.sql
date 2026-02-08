-- Hacer staff_id nullable en tabla tickets para permitir creación anónima
ALTER TABLE tickets ALTER COLUMN staff_id DROP NOT NULL;
