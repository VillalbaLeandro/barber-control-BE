# User Flows - Gestión Peluquería

## 👤 Flujo Usuario Base (Peluquero/Staff)

```mermaid
graph TD
    A[Inicio] --> B[Seleccionar Punto de Venta]
    B --> C[Ingresar PIN]
    C --> D{PIN Válido?}
    D -->|No| C
    D -->|Sí| E[Dashboard Staff]
    
    E --> F[Opción: Venta]
    E --> G[Opción: Consumo Staff]
    E --> H[Opción: Historial]
    
    F --> F1[Ver Catálogo Servicios/Productos]
    F1 --> F2[Agregar Items al Ticket]
    F2 --> F3[Confirmar Venta]
    F3 --> F4[Seleccionar Método de Pago]
    F4 --> F5[✅ Venta Confirmada]
    
    G --> G1[Ver Productos Disponibles]
    G1 --> G2[Seleccionar Items para Consumo]
    G2 --> G3[Confirmar Solicitud]
    G3 --> G4[⏳ Pendiente de Aprobación]
    
    H --> H1[Ver Mis Transacciones]
    H1 --> H2[Ver Detalle de Transacción]
```

## 👨‍💼 Flujo Usuario Admin

```mermaid
graph TD
    A[Inicio] --> B[Login Admin]
    B --> C[Panel Administrativo]
    
    C --> D[Dashboard]
    C --> E[Gestión de Ventas]
    C --> F[Gestión de Consumos Staff]
    C --> G[Cierre de Caja]
    C --> H[Configuración]
    
    D --> D1[Ver Métricas del Día]
    D1 --> D2[Ver Alertas Pendientes]
    D2 --> D3[Ver Gráficos de Performance]
    
    E --> E1[Ver Todas las Transacciones]
    E1 --> E2[Filtrar por Fecha/Local/Staff]
    E2 --> E3[Ver Detalle]
    E3 --> E4[Opción: Anular Transacción]
    
    F --> F1[Ver Consumos Pendientes]
    F1 --> F2{Acción}
    F2 -->|Aprobar Total| F3[✅ Charge]
    F2 -->|Aprobar Parcial| F4[💰 Charge Partial]
    F2 -->|Perdonar| F5[🎁 Forgive]
    F2 -->|Rechazar| F6[❌ Reject]
    
    G --> G1[Ver Resumen del Día]
    G1 --> G2[Verificar Totales]
    G2 --> G3[Cerrar Caja]
    G3 --> G4[📄 Generar Reporte Z]
    
    H --> H1[CRUD Staff]
    H --> H2[CRUD Servicios]
    H --> H3[CRUD Productos]
    H --> H4[CRUD Puntos de Venta]
    H --> H5[Configuración General]
```

## 🔄 Flujo Detallado: Venta Completa

```mermaid
sequenceDiagram
    participant U as Usuario/Staff
    participant F as Frontend
    participant A as API
    participant DB as Database
    
    U->>F: Selecciona Punto de Venta
    F->>A: GET /puntos-venta
    A->>DB: Query puntos_venta
    DB-->>A: Lista de puntos
    A-->>F: Puntos de venta
    
    U->>F: Ingresa PIN
    F->>A: POST /staff/validar-pin
    A->>DB: Validar PIN + Check bloqueo
    DB-->>A: Staff data
    A-->>F: {id, nombre, rol}
    
    U->>F: Crea nueva venta
    F->>A: POST /ventas/crear-ticket
    A->>DB: INSERT ticket temporal
    DB-->>A: ticketId
    A-->>F: {ticketId, items: []}
    
    U->>F: Agrega servicio
    F->>A: POST /ventas/ticket/:id/agregar-item
    A->>DB: UPDATE ticket
    DB-->>A: Ticket actualizado
    A-->>F: {ticket con items}
    
    U->>F: Confirma venta
    F->>A: POST /ventas/confirmar
    A->>DB: BEGIN TRANSACTION
    A->>DB: INSERT INTO ventas
    A->>DB: INSERT INTO detalles_venta
    A->>DB: UPDATE stock (si aplica)
    A->>DB: COMMIT
    DB-->>A: ventaId
    A-->>F: {success, ventaId, #TRX-xxxxx}
    F-->>U: ✅ Venta Confirmada
```

## 🔄 Flujo Detallado: Consumo Staff

```mermaid
sequenceDiagram
    participant S as Staff
    participant F as Frontend
    participant A as API
    participant DB as Database
    participant AD as Admin
    
    S->>F: Solicita consumo
    F->>A: POST /consumos/crear
    A->>DB: INSERT consumo (estado: pending)
    DB-->>A: consumoId
    A-->>F: {consumoId, estado: 'pending'}
    F-->>S: ⏳ Solicitud enviada
    
    Note over S,AD: Espera aprobación...
    
    AD->>F: Ve consumos pendientes
    F->>A: GET /consumos/pendientes
    A->>DB: Query consumos WHERE estado=pending
    DB-->>A: Lista de consumos
    A-->>F: [{id, staff, items, total}]
    
    AD->>F: Decide aprobar
    F->>A: POST /consumos/:id/aprobar
    A->>DB: BEGIN TRANSACTION
    A->>DB: UPDATE consumo SET estado=approved
    A->>DB: UPDATE staff (descuento de sueldo?)
    A->>DB: COMMIT
    DB-->>A: Success
    A-->>F: {success}
    F-->>AD: ✅ Consumo aprobado
```

---

## 📊 Matriz de Endpoints por Flujo

| Flujo | Endpoints Necesarios | Prioridad |
|-------|---------------------|-----------|
| **Login y Sesión** | `/staff/validar-pin`, `/puntos-venta`, `/session/punto-venta` | 🔴 Alta |
| **Venta Básica** | `/catalogo/*`, `/ventas/confirmar` | 🔴 Alta |
| **Venta con Carrito** | `/ventas/crear-ticket`, `/ventas/ticket/*` | 🟡 Media |
| **Consumo Staff (Staff)** | `/consumos/crear`, `/consumos/pendientes` | 🔴 Alta |
| **Consumo Staff (Admin)** | `/consumos/:id/aprobar`, `/consumos/:id/perdonar`, etc. | 🟡 Media |
| **Historial** | `/transacciones`, `/transacciones/:id` | 🟡 Media |
| **Cierre de Caja** | `/caja/*` | 🟢 Baja |
| **Admin Dashboard** | `/admin/dashboard`, `/admin/alertas` | 🟢 Baja |
| **CRUD Config** | `/admin/staff`, `/admin/servicios`, etc. | 🟢 Baja |
