-- =====================================================
-- Migración 010: Row-Level Security (RLS)
-- Fecha: 2026-02-09
-- Descripción: Implementa políticas de seguridad a nivel de base de datos
--              para garantizar aislamiento automático entre empresas
-- =====================================================

-- ========================================
-- PASO 1: Habilitar RLS en todas las tablas
-- ========================================

-- Tablas principales
ALTER TABLE empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE puntos_venta ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE productos ENABLE ROW LEVEL SECURITY;
ALTER TABLE servicios ENABLE ROW LEVEL SECURITY;
ALTER TABLE cajas ENABLE ROW LEVEL SECURITY;
ALTER TABLE cierres_caja ENABLE ROW LEVEL SECURITY;
ALTER TABLE transacciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaccion_detalles ENABLE ROW LEVEL SECURITY;

-- Tablas de configuración (pueden ser globales o por empresa)
ALTER TABLE medios_pago ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;

-- Tablas de sesiones y tickets
ALTER TABLE sesiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;

-- Tablas de consumos staff
ALTER TABLE consumos_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumo_staff_liquidacion ENABLE ROW LEVEL SECURITY;

-- ========================================
-- PASO 2: Crear políticas de seguridad
-- ========================================

-- Función helper para obtener empresa_id de la sesión
CREATE OR REPLACE FUNCTION get_current_empresa_id()
RETURNS UUID AS $$
BEGIN
    RETURN current_setting('app.current_empresa_id', true)::UUID;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- ========================================
-- Políticas para tablas principales
-- ========================================

-- EMPRESAS: Ver solo la empresa actual
CREATE POLICY empresa_isolation ON empresas
    FOR ALL
    USING (id = get_current_empresa_id());

-- PUNTOS DE VENTA
CREATE POLICY empresa_isolation ON puntos_venta
    FOR ALL
    USING (empresa_id = get_current_empresa_id());

-- USUARIOS
CREATE POLICY empresa_isolation ON usuarios
    FOR ALL
    USING (empresa_id = get_current_empresa_id());

-- PRODUCTOS
CREATE POLICY empresa_isolation ON productos
    FOR ALL
    USING (empresa_id = get_current_empresa_id());

-- SERVICIOS
CREATE POLICY empresa_isolation ON servicios
    FOR ALL
    USING (empresa_id = get_current_empresa_id());

-- CAJAS
CREATE POLICY empresa_isolation ON cajas
    FOR ALL
    USING (empresa_id = get_current_empresa_id());

-- CIERRES DE CAJA
CREATE POLICY empresa_isolation ON cierres_caja
    FOR ALL
    USING (empresa_id = get_current_empresa_id());

-- TRANSACCIONES
CREATE POLICY empresa_isolation ON transacciones
    FOR ALL
    USING (empresa_id = get_current_empresa_id());

-- TRANSACCION DETALLES (a través de transacciones)
CREATE POLICY empresa_isolation ON transaccion_detalles
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM transacciones t
            WHERE t.id = transaccion_detalles.transaccion_id
            AND t.empresa_id = get_current_empresa_id()
        )
    );

-- ========================================
-- Políticas para tablas con NULL permitido
-- ========================================

-- MEDIOS DE PAGO (NULL = global, UUID = específico de empresa)
CREATE POLICY empresa_isolation ON medios_pago
    FOR ALL
    USING (
        empresa_id IS NULL OR 
        empresa_id = get_current_empresa_id()
    );

-- ROLES (NULL = global, UUID = específico de empresa)
CREATE POLICY empresa_isolation ON roles
    FOR ALL
    USING (
        empresa_id IS NULL OR 
        empresa_id = get_current_empresa_id()
    );

-- ========================================
-- Políticas para sesiones y tickets
-- ========================================

-- SESIONES (a través de usuarios)
CREATE POLICY empresa_isolation ON sesiones
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM usuarios u
            WHERE u.id = sesiones.usuario_id
            AND u.empresa_id = get_current_empresa_id()
        )
    );

-- TICKETS (a través de punto_venta)
CREATE POLICY empresa_isolation ON tickets
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM puntos_venta pv
            WHERE pv.id = tickets.punto_venta_id
            AND pv.empresa_id = get_current_empresa_id()
        )
    );

-- ========================================
-- Políticas para consumos staff
-- ========================================

-- CONSUMOS STAFF (a través de punto_venta)
CREATE POLICY empresa_isolation ON consumos_staff
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM puntos_venta pv
            WHERE pv.id = consumos_staff.punto_venta_id
            AND pv.empresa_id = get_current_empresa_id()
        )
    );

-- CONSUMO STAFF LIQUIDACION (a través de transacciones)
CREATE POLICY empresa_isolation ON consumo_staff_liquidacion
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM transacciones t
            WHERE t.id = consumo_staff_liquidacion.transaccion_id
            AND t.empresa_id = get_current_empresa_id()
        )
    );

-- ========================================
-- PASO 3: Crear rol de bypass para admins
-- ========================================

-- Crear política especial para superadmins que pueden ver todo
-- (útil para debugging y soporte técnico)
CREATE POLICY bypass_rls ON empresas
    FOR ALL
    TO PUBLIC
    USING (
        current_setting('app.bypass_rls', true)::boolean = true
    );

-- ========================================
-- PASO 4: Comentarios y documentación
-- ========================================

COMMENT ON FUNCTION get_current_empresa_id() IS 
    'Obtiene el empresa_id de la sesión actual de PostgreSQL. 
     Debe ser configurado por el backend usando SET LOCAL.';

COMMENT ON POLICY empresa_isolation ON puntos_venta IS
    'Política RLS: Solo permite acceso a puntos de venta de la empresa actual';

COMMENT ON POLICY empresa_isolation ON transacciones IS
    'Política RLS: Solo permite acceso a transacciones de la empresa actual';

-- ========================================
-- PASO 5: Verificación de seguridad
-- ========================================

-- Crear función de test para verificar RLS
CREATE OR REPLACE FUNCTION test_rls_isolation()
RETURNS TABLE(
    tabla TEXT,
    total_rows BIGINT,
    empresa_actual UUID,
    rows_visibles BIGINT,
    aislamiento_ok BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        'productos'::TEXT,
        (SELECT COUNT(*) FROM productos)::BIGINT,
        get_current_empresa_id(),
        (SELECT COUNT(*) FROM productos WHERE empresa_id = get_current_empresa_id())::BIGINT,
        (SELECT COUNT(*) FROM productos) = (SELECT COUNT(*) FROM productos WHERE empresa_id = get_current_empresa_id())
    ;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION test_rls_isolation() IS
    'Función de test para verificar que RLS está funcionando correctamente.
     Ejecutar después de configurar app.current_empresa_id.';

-- =====================================================
-- Fin de migración 010 - Row-Level Security
-- =====================================================

-- IMPORTANTE: Para que RLS funcione, el backend DEBE configurar
-- la variable de sesión antes de cada query:
-- 
-- SET LOCAL app.current_empresa_id = 'uuid-de-la-empresa';
-- 
-- Esto se hace automáticamente con el middleware que se implementará.
