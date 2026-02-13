-- =====================================================
-- Migracion 020: Endurecimiento RLS multiempresa
-- Fecha: 2026-02-11
-- Descripcion:
--  - Fuerza aplicacion de RLS en tablas criticas
--  - Reemplaza politicas FOR ALL con USING + WITH CHECK
--  - Agrega helper robusto para bypass por variable de sesion
-- =====================================================

CREATE OR REPLACE FUNCTION get_current_empresa_id()
RETURNS UUID AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_empresa_id', true), '')::UUID;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION is_rls_bypass_enabled()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN COALESCE(NULLIF(current_setting('app.bypass_rls', true), '')::BOOLEAN, false);
EXCEPTION
    WHEN OTHERS THEN
        RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

-- Aplicar FORCE RLS sobre tablas criticas (si existen)
DO $$
DECLARE
    t TEXT;
    tables TEXT[] := ARRAY[
        'empresas',
        'puntos_venta',
        'usuarios',
        'cajas',
        'cierres_caja',
        'transacciones',
        'transaccion_detalles',
        'tickets',
        'sesiones',
        'consumos_staff',
        'consumo_staff_liquidacion',
        'medios_pago',
        'roles'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
        END IF;
    END LOOP;
END $$;

-- empresas
DO $$
BEGIN
    IF to_regclass('public.empresas') IS NOT NULL THEN
        DROP POLICY IF EXISTS empresa_isolation ON public.empresas;
        DROP POLICY IF EXISTS bypass_rls ON public.empresas;
        CREATE POLICY empresa_isolation ON public.empresas
            FOR ALL
            USING (is_rls_bypass_enabled() OR id = get_current_empresa_id())
            WITH CHECK (is_rls_bypass_enabled() OR id = get_current_empresa_id());
    END IF;
END $$;

-- puntos_venta
DO $$
BEGIN
    IF to_regclass('public.puntos_venta') IS NOT NULL THEN
        DROP POLICY IF EXISTS empresa_isolation ON public.puntos_venta;
        CREATE POLICY empresa_isolation ON public.puntos_venta
            FOR ALL
            USING (is_rls_bypass_enabled() OR empresa_id = get_current_empresa_id())
            WITH CHECK (is_rls_bypass_enabled() OR empresa_id = get_current_empresa_id());
    END IF;
END $$;

-- usuarios
DO $$
BEGIN
    IF to_regclass('public.usuarios') IS NOT NULL THEN
        DROP POLICY IF EXISTS empresa_isolation ON public.usuarios;
        CREATE POLICY empresa_isolation ON public.usuarios
            FOR ALL
            USING (is_rls_bypass_enabled() OR empresa_id = get_current_empresa_id())
            WITH CHECK (is_rls_bypass_enabled() OR empresa_id = get_current_empresa_id());
    END IF;
END $$;

-- cajas
DO $$
BEGIN
    IF to_regclass('public.cajas') IS NOT NULL THEN
        DROP POLICY IF EXISTS empresa_isolation ON public.cajas;
        CREATE POLICY empresa_isolation ON public.cajas
            FOR ALL
            USING (is_rls_bypass_enabled() OR empresa_id = get_current_empresa_id())
            WITH CHECK (is_rls_bypass_enabled() OR empresa_id = get_current_empresa_id());
    END IF;
END $$;

-- cierres_caja
DO $$
BEGIN
    IF to_regclass('public.cierres_caja') IS NOT NULL THEN
        DROP POLICY IF EXISTS empresa_isolation ON public.cierres_caja;
        CREATE POLICY empresa_isolation ON public.cierres_caja
            FOR ALL
            USING (is_rls_bypass_enabled() OR empresa_id = get_current_empresa_id())
            WITH CHECK (is_rls_bypass_enabled() OR empresa_id = get_current_empresa_id());
    END IF;
END $$;

-- transacciones
DO $$
BEGIN
    IF to_regclass('public.transacciones') IS NOT NULL THEN
        DROP POLICY IF EXISTS empresa_isolation ON public.transacciones;
        CREATE POLICY empresa_isolation ON public.transacciones
            FOR ALL
            USING (is_rls_bypass_enabled() OR empresa_id = get_current_empresa_id())
            WITH CHECK (is_rls_bypass_enabled() OR empresa_id = get_current_empresa_id());
    END IF;
END $$;

-- transaccion_detalles
DO $$
BEGIN
    IF to_regclass('public.transaccion_detalles') IS NOT NULL THEN
        DROP POLICY IF EXISTS empresa_isolation ON public.transaccion_detalles;
        CREATE POLICY empresa_isolation ON public.transaccion_detalles
            FOR ALL
            USING (
                is_rls_bypass_enabled() OR EXISTS (
                    SELECT 1
                    FROM public.transacciones t
                    WHERE t.id = transaccion_detalles.transaccion_id
                      AND t.empresa_id = get_current_empresa_id()
                )
            )
            WITH CHECK (
                is_rls_bypass_enabled() OR EXISTS (
                    SELECT 1
                    FROM public.transacciones t
                    WHERE t.id = transaccion_detalles.transaccion_id
                      AND t.empresa_id = get_current_empresa_id()
                )
            );
    END IF;
END $$;

-- tickets
DO $$
BEGIN
    IF to_regclass('public.tickets') IS NOT NULL THEN
        DROP POLICY IF EXISTS empresa_isolation ON public.tickets;
        CREATE POLICY empresa_isolation ON public.tickets
            FOR ALL
            USING (
                is_rls_bypass_enabled() OR EXISTS (
                    SELECT 1
                    FROM public.puntos_venta pv
                    WHERE pv.id = tickets.punto_venta_id
                      AND pv.empresa_id = get_current_empresa_id()
                )
            )
            WITH CHECK (
                is_rls_bypass_enabled() OR EXISTS (
                    SELECT 1
                    FROM public.puntos_venta pv
                    WHERE pv.id = tickets.punto_venta_id
                      AND pv.empresa_id = get_current_empresa_id()
                )
            );
    END IF;
END $$;

-- sesiones
DO $$
BEGIN
    IF to_regclass('public.sesiones') IS NOT NULL THEN
        DROP POLICY IF EXISTS empresa_isolation ON public.sesiones;
        CREATE POLICY empresa_isolation ON public.sesiones
            FOR ALL
            USING (
                is_rls_bypass_enabled() OR EXISTS (
                    SELECT 1
                    FROM public.usuarios u
                    WHERE u.id = sesiones.usuario_id
                      AND u.empresa_id = get_current_empresa_id()
                )
            )
            WITH CHECK (
                is_rls_bypass_enabled() OR EXISTS (
                    SELECT 1
                    FROM public.usuarios u
                    WHERE u.id = sesiones.usuario_id
                      AND u.empresa_id = get_current_empresa_id()
                )
            );
    END IF;
END $$;

-- consumos_staff
DO $$
BEGIN
    IF to_regclass('public.consumos_staff') IS NOT NULL THEN
        DROP POLICY IF EXISTS empresa_isolation ON public.consumos_staff;
        CREATE POLICY empresa_isolation ON public.consumos_staff
            FOR ALL
            USING (
                is_rls_bypass_enabled() OR EXISTS (
                    SELECT 1
                    FROM public.puntos_venta pv
                    WHERE pv.id = consumos_staff.punto_venta_id
                      AND pv.empresa_id = get_current_empresa_id()
                )
            )
            WITH CHECK (
                is_rls_bypass_enabled() OR EXISTS (
                    SELECT 1
                    FROM public.puntos_venta pv
                    WHERE pv.id = consumos_staff.punto_venta_id
                      AND pv.empresa_id = get_current_empresa_id()
                )
            );
    END IF;
END $$;

-- consumo_staff_liquidacion
DO $$
BEGIN
    IF to_regclass('public.consumo_staff_liquidacion') IS NOT NULL THEN
        DROP POLICY IF EXISTS empresa_isolation ON public.consumo_staff_liquidacion;
        CREATE POLICY empresa_isolation ON public.consumo_staff_liquidacion
            FOR ALL
            USING (
                is_rls_bypass_enabled() OR EXISTS (
                    SELECT 1
                    FROM public.transacciones t
                    WHERE t.id = consumo_staff_liquidacion.transaccion_id
                      AND t.empresa_id = get_current_empresa_id()
                )
            )
            WITH CHECK (
                is_rls_bypass_enabled() OR EXISTS (
                    SELECT 1
                    FROM public.transacciones t
                    WHERE t.id = consumo_staff_liquidacion.transaccion_id
                      AND t.empresa_id = get_current_empresa_id()
                )
            );
    END IF;
END $$;

-- medios_pago (global o empresa)
DO $$
BEGIN
    IF to_regclass('public.medios_pago') IS NOT NULL THEN
        DROP POLICY IF EXISTS empresa_isolation ON public.medios_pago;
        CREATE POLICY empresa_isolation ON public.medios_pago
            FOR ALL
            USING (
                is_rls_bypass_enabled() OR empresa_id IS NULL OR empresa_id = get_current_empresa_id()
            )
            WITH CHECK (
                is_rls_bypass_enabled() OR empresa_id IS NULL OR empresa_id = get_current_empresa_id()
            );
    END IF;
END $$;

-- roles (global o empresa)
DO $$
BEGIN
    IF to_regclass('public.roles') IS NOT NULL THEN
        DROP POLICY IF EXISTS empresa_isolation ON public.roles;
        CREATE POLICY empresa_isolation ON public.roles
            FOR ALL
            USING (
                is_rls_bypass_enabled() OR empresa_id IS NULL OR empresa_id = get_current_empresa_id()
            )
            WITH CHECK (
                is_rls_bypass_enabled() OR empresa_id IS NULL OR empresa_id = get_current_empresa_id()
            );
    END IF;
END $$;

COMMENT ON FUNCTION is_rls_bypass_enabled() IS
    'Devuelve true si app.bypass_rls esta seteado en sesion. Uso controlado para soporte tecnico.';
