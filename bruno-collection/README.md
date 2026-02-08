# Bruno Collection - Gestión Peluquería API

Esta colección contiene todos los endpoints de la API para probar el backend.

## 📦 Importar en Bruno

1. Abre Bruno
2. Click en "Import Collection"
3. Selecciona la carpeta `bruno-collection`
4. ¡Listo! Ya puedes probar todos los endpoints

## 🌍 Entornos

La colección incluye un entorno **Local** con las siguientes variables:

- `baseUrl`: http://localhost:3000
- `staffId`: UUID de ejemplo para pruebas
- `pin`: PIN de ejemplo (1234)

Puedes editar estas variables en Bruno según tus datos de prueba.

## 📋 Endpoints Disponibles

### General
- **Health Check** - Verifica estado del servidor y DB

### Puntos de Venta
- **Listar Puntos de Venta** - GET `/puntos-venta`

### Catálogo
- **Listar Servicios** - GET `/catalogo/servicios`
- **Listar Productos** - GET `/catalogo/productos`

### Staff
- **Validar PIN - Correcto** - POST `/staff/validar-pin` (con PIN válido)
- **Validar PIN - Incorrecto** - POST `/staff/validar-pin` (PIN inválido)
- **Validar PIN - Validación Fallida** - POST `/staff/validar-pin` (datos mal formateados)

### Ventas
- **Confirmar Venta** - POST `/ventas/confirmar`

### Consumos
- **Confirmar Consumo Staff** - POST `/consumos/confirmar`

## 🔒 Seguridad

El endpoint de validación de PIN incluye:
- ✅ Rate limiting: 5 intentos por minuto
- ✅ Bloqueo temporal: 15 minutos después de 5 intentos fallidos
- ✅ Validación Zod: PIN de 4 caracteres + UUID

## 💡 Notas

- Asegúrate de que el servidor esté corriendo en `http://localhost:3000`
- Los UUIDs de ejemplo necesitan ser reemplazados con datos reales de tu base de datos
- Algunos endpoints requieren que existan las tablas correspondientes en Supabase
