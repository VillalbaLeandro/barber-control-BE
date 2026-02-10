-- ============================================================================
-- MIGRACIÓN 008: Tablas de Cajas y Cierres
-- ============================================================================
-- Objetivo: Crear tablas para gestión de cajas y cierres diarios
-- ============================================================================

BEGIN;

-- ============================================================================
-- TABLA: cajas
-- ============================================================================
CREATE TABLE IF NOT EXISTS cajas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    punto_venta_id UUID NOT NULL REFERENCES puntos_venta(id) ON DELETE CASCADE,
    nombre VARCHAR(100) NOT NULL,
    es_virtual BOOLEAN DEFAULT false,
    activa BOOLEAN DEFAULT true,
    monto_inicial_actual DECIMAL(10,2) DEFAULT 0,
    fecha_apertura_actual TIMESTAMP,
    abierta BOOLEAN DEFAULT false,
    creado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    actualizado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices para cajas
CREATE INDEX IF NOT EXISTS idx_cajas_punto_venta ON cajas(punto_venta_id);
CREATE INDEX IF NOT EXISTS idx_cajas_activa ON cajas(activa);
CREATE INDEX IF NOT EXISTS idx_cajas_abierta ON cajas(abierta);

-- ============================================================================
-- TABLA: cierres_caja
-- ============================================================================
CREATE TABLE IF NOT EXISTS cierres_caja (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    caja_id UUID NOT NULL REFERENCES cajas(id) ON DELETE CASCADE,
    cerrada_por_usuario_id UUID REFERENCES usuarios(id),
    fecha_apertura TIMESTAMP WITH TIME ZONE NOT NULL,
    fecha_cierre TIMESTAMP WITH TIME ZONE NOT NULL,
    monto_inicial DECIMAL(10,2) NOT NULL DEFAULT 0,
    monto_esperado DECIMAL(10,2) NOT NULL DEFAULT 0,
    monto_real DECIMAL(10,2) NOT NULL DEFAULT 0,
    diferencia DECIMAL(10,2) NOT NULL DEFAULT 0,
    total_ventas DECIMAL(10,2) DEFAULT 0,
    total_efectivo DECIMAL(10,2) DEFAULT 0,
    total_tarjeta DECIMAL(10,2) DEFAULT 0,
    total_transferencia DECIMAL(10,2) DEFAULT 0,
    cantidad_transacciones INTEGER DEFAULT 0,
    observaciones TEXT,
    creado_en TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices para cierres_caja
CREATE INDEX IF NOT EXISTS idx_cierres_caja_id ON cierres_caja(caja_id);
CREATE INDEX IF NOT EXISTS idx_cierres_fecha_cierre ON cierres_caja(fecha_cierre);
CREATE INDEX IF NOT EXISTS idx_cierres_usuario ON cierres_caja(cerrada_por_usuario_id);

-- ============================================================================
-- DATOS INICIALES: Crear caja por defecto para cada punto de venta
-- ============================================================================
INSERT INTO cajas (punto_venta_id, nombre, es_virtual, activa)
SELECT 
    id,
    'Caja Principal',
    false,
    true
FROM puntos_venta
WHERE NOT EXISTS (
    SELECT 1 FROM cajas WHERE cajas.punto_venta_id = puntos_venta.id
);

COMMIT;

-- ============================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- ============================================================================
-- SELECT * FROM cajas;
-- SELECT * FROM cierres_caja;
-- ============================================================================
