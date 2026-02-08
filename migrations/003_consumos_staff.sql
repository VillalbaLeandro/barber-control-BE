-- Tabla Consumos Staff
CREATE TABLE IF NOT EXISTS consumos_staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID REFERENCES staff(id) NOT NULL,
    punto_venta_id UUID REFERENCES puntos_venta(id),
    items JSONB NOT NULL,
    total_venta DECIMAL(10,2) NOT NULL,
    total_costo DECIMAL(10,2) NOT NULL,
    estado_liquidacion VARCHAR(20) DEFAULT 'pendiente', -- pendiente, cobrado, perdonado, parcial
    creado_en TIMESTAMP DEFAULT NOW(),
    liquidado_en TIMESTAMP
);

-- Indices para consumos
CREATE INDEX IF NOT EXISTS idx_consumos_staff_staff_id ON consumos_staff(staff_id);
CREATE INDEX IF NOT EXISTS idx_consumos_staff_pv_id ON consumos_staff(punto_venta_id);
CREATE INDEX IF NOT EXISTS idx_consumos_staff_estado ON consumos_staff(estado_liquidacion);
CREATE INDEX IF NOT EXISTS idx_consumos_staff_fecha ON consumos_staff(creado_en);

-- Tabla Liquidaciones de Consumo
CREATE TABLE IF NOT EXISTS liquidaciones_consumo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consumo_id UUID REFERENCES consumos_staff(id) NOT NULL,
    admin_id UUID, -- Referencia opcional hasta tener tabla de admins
    regla_aplicada VARCHAR(50), -- precio_venta, precio_costo, porcentaje, monto_fijo
    valor_regla DECIMAL(10,2),
    monto_cobrado DECIMAL(10,2) NOT NULL,
    motivo TEXT,
    creado_en TIMESTAMP DEFAULT NOW()
);

-- Indices para liquidaciones
CREATE INDEX IF NOT EXISTS idx_liquidaciones_consumo_id ON liquidaciones_consumo(consumo_id);
CREATE INDEX IF NOT EXISTS idx_liquidaciones_fecha ON liquidaciones_consumo(creado_en);
