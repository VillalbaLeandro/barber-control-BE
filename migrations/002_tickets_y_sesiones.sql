-- Sprint 2: Tablas para sistema de tickets y sesiones

-- Tabla de tickets (carritos temporales)
CREATE TABLE IF NOT EXISTS tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL REFERENCES staff(id),
    punto_venta_id UUID NOT NULL REFERENCES puntos_venta(id),
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    total DECIMAL(10,2) NOT NULL DEFAULT 0,
    estado VARCHAR(20) NOT NULL DEFAULT 'draft', -- draft, confirmed, cancelled
    creado_en TIMESTAMP NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMP DEFAULT NOW()
);

-- Tabla de sesiones (para tracking de staff en puntos de venta)
CREATE TABLE IF NOT EXISTS sesiones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL UNIQUE REFERENCES staff(id),
    punto_venta_id UUID NOT NULL REFERENCES puntos_venta(id),
    inicio_sesion TIMESTAMP NOT NULL DEFAULT NOW(),
    fin_sesion TIMESTAMP,
    creado_en TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Índices para mejor performance
CREATE INDEX IF NOT EXISTS idx_tickets_staff ON tickets(staff_id);
CREATE INDEX IF NOT EXISTS idx_tickets_punto_venta ON tickets(punto_venta_id);
CREATE INDEX IF NOT EXISTS idx_tickets_estado ON tickets(estado);
CREATE INDEX IF NOT EXISTS idx_sesiones_staff ON sesiones(staff_id);
CREATE INDEX IF NOT EXISTS idx_sesiones_activas ON sesiones(staff_id, fin_sesion) WHERE fin_sesion IS NULL;

-- Comentarios
COMMENT ON TABLE tickets IS 'Tickets temporales (carritos) para el sistema POS';
COMMENT ON TABLE sesiones IS 'Sesiones activas de staff en puntos de venta';
COMMENT ON COLUMN tickets.items IS 'Array JSON de items: [{tipo, itemId, cantidad, precio, subtotal}]';
COMMENT ON COLUMN tickets.estado IS 'Estados: draft (en proceso), confirmed (convertido a venta), cancelled (cancelado)';
