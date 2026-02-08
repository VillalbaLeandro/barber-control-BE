# Migraciones de Base de Datos

## Cómo ejecutar migraciones

Las migraciones deben ejecutarse en orden numérico en Supabase SQL Editor.

### Sprint 2: Tickets y Sesiones

Ejecuta el archivo `002_tickets_y_sesiones.sql` en Supabase:

1. Abre Supabase Dashboard
2. Ve a SQL Editor
3. Copia y pega el contenido de `002_tickets_y_sesiones.sql`
4. Ejecuta el script

## Tablas creadas

### `tickets`
Almacena carritos temporales (tickets en draft) antes de confirmar la venta.

**Campos principales:**
- `id` - UUID del ticket
- `staff_id` - Staff que creó el ticket
- `punto_venta_id` - Punto de venta activo
- `items` - Array JSON de items `[{tipo, itemId, cantidad, precio, subtotal}]`
- `total` - Total calculado
- `estado` - `draft`, `confirmed`, `cancelled`

### `sesiones`
Rastrea sesiones activas de staff en puntos de venta.

**Campos principales:**
- `staff_id` - Staff (UNIQUE - solo una sesión activa por staff)
- `punto_venta_id` - Punto de venta donde está trabajando
- `inicio_sesion` - Timestamp de inicio
- `fin_sesion` - NULL si está activa, timestamp si cerró

## Índices

- `idx_tickets_staff` - Búsqueda rápida de tickets por staff
- `idx_tickets_punto_venta` - Búsqueda por punto de venta
- `idx_tickets_estado` - Filtrado por estado
- `idx_sesiones_activas` - Búsqueda de sesiones activas (WHERE fin_sesion IS NULL)

## Verificación

Después de ejecutar la migración, verifica:

```sql
-- Ver tablas creadas
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('tickets', 'sesiones');

-- Ver índices
SELECT indexname FROM pg_indexes 
WHERE tablename IN ('tickets', 'sesiones');
```
