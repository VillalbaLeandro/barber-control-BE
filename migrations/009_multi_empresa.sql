-- =====================================================
-- Migración 009: Soporte Multi-Empresa
-- Fecha: 2026-02-09
-- Descripción: Agrega soporte para múltiples empresas
-- =====================================================

-- 1. Crear tabla empresas
CREATE TABLE IF NOT EXISTS empresas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR NOT NULL,
    razon_social VARCHAR,
    identificacion_fiscal VARCHAR UNIQUE, -- RUT, CUIT, DNI, etc.
    activa BOOLEAN NOT NULL DEFAULT true,
    configuracion JSONB DEFAULT '{}', -- Configuración específica por empresa
    creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Insertar empresa por defecto (para datos existentes)
INSERT INTO empresas (nombre, razon_social, activa)
VALUES ('Empresa Principal', 'Empresa Principal', true)
ON CONFLICT DO NOTHING;

-- 3. Agregar empresa_id a tablas principales (permitir NULL temporalmente)
ALTER TABLE puntos_venta ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresas(id);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresas(id);
ALTER TABLE productos ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresas(id);
ALTER TABLE servicios ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresas(id);
ALTER TABLE cajas ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresas(id);
ALTER TABLE cierres_caja ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresas(id);
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresas(id);

-- 4. Actualizar datos existentes con la empresa por defecto
UPDATE puntos_venta SET empresa_id = (SELECT id FROM empresas LIMIT 1) WHERE empresa_id IS NULL;
UPDATE usuarios SET empresa_id = (SELECT id FROM empresas LIMIT 1) WHERE empresa_id IS NULL;
UPDATE productos SET empresa_id = (SELECT id FROM empresas LIMIT 1) WHERE empresa_id IS NULL;
UPDATE servicios SET empresa_id = (SELECT id FROM empresas LIMIT 1) WHERE empresa_id IS NULL;
UPDATE cajas SET empresa_id = (SELECT id FROM empresas LIMIT 1) WHERE empresa_id IS NULL;
UPDATE cierres_caja SET empresa_id = (SELECT id FROM empresas LIMIT 1) WHERE empresa_id IS NULL;
UPDATE transacciones SET empresa_id = (SELECT id FROM empresas LIMIT 1) WHERE empresa_id IS NULL;

-- 5. Hacer NOT NULL después de actualizar datos
ALTER TABLE puntos_venta ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE usuarios ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE productos ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE servicios ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE cajas ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE cierres_caja ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE transacciones ALTER COLUMN empresa_id SET NOT NULL;

-- 6. Crear índices para performance
CREATE INDEX IF NOT EXISTS idx_puntos_venta_empresa ON puntos_venta(empresa_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_empresa ON usuarios(empresa_id);
CREATE INDEX IF NOT EXISTS idx_productos_empresa ON productos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_servicios_empresa ON servicios(empresa_id);
CREATE INDEX IF NOT EXISTS idx_cajas_empresa ON cajas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_cierres_caja_empresa ON cierres_caja(empresa_id);
CREATE INDEX IF NOT EXISTS idx_transacciones_empresa ON transacciones(empresa_id);

-- 7. Índices compuestos para queries frecuentes
CREATE INDEX IF NOT EXISTS idx_cajas_empresa_pv ON cajas(empresa_id, punto_venta_id);
CREATE INDEX IF NOT EXISTS idx_transacciones_empresa_fecha ON transacciones(empresa_id, confirmado_en);
CREATE INDEX IF NOT EXISTS idx_productos_empresa_activo ON productos(empresa_id, activo);
CREATE INDEX IF NOT EXISTS idx_servicios_empresa_activo ON servicios(empresa_id, activo);

-- 8. Agregar empresa_id a medios_pago y roles (NULL = global, compartido entre empresas)
ALTER TABLE medios_pago ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresas(id);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresas(id);

-- 9. Índices para medios_pago y roles
CREATE INDEX IF NOT EXISTS idx_medios_pago_empresa ON medios_pago(empresa_id);
CREATE INDEX IF NOT EXISTS idx_roles_empresa ON roles(empresa_id);

-- 10. Comentarios para documentación
COMMENT ON TABLE empresas IS 'Tabla de empresas para soporte multi-tenant';
COMMENT ON COLUMN empresas.configuracion IS 'Configuración específica de la empresa en formato JSON';
COMMENT ON COLUMN medios_pago.empresa_id IS 'NULL = medio de pago global, UUID = específico de empresa';
COMMENT ON COLUMN roles.empresa_id IS 'NULL = rol global, UUID = específico de empresa';

-- =====================================================
-- Fin de migración 009
-- =====================================================
