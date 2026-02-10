// =====================================================
// Tipos para arquitectura Supertype/Subtype
// =====================================================

/**
 * Tabla base: items
 * Contiene campos comunes a todos los items vendibles
 */
export interface Item {
    id: string;
    tipo: 'producto' | 'servicio' | 'combo';
    nombre: string;
    categoria: string;
    precio_venta: number;
    activo: boolean;
    orden_ui: number;
    empresa_id: string;
    creado_en: Date;
    actualizado_en: Date;
}

/**
 * Detalles específicos de productos
 */
export interface ItemProductoDetalle {
    item_id: string;
    costo: number;
    maneja_stock: boolean;
    stock_actual: number;
    stock_minimo: number;
    permite_consumo_staff: boolean;
}

/**
 * Detalles específicos de servicios
 */
export interface ItemServicioDetalle {
    item_id: string;
    duracion_min: number | null;
}

/**
 * Detalles específicos de combos
 */
export interface ItemComboDetalle {
    item_id: string;
}

/**
 * Item de un combo
 */
export interface ComboItem {
    combo_id: string;
    item_id: string;
    cantidad: number;
    nombre?: string; // Poblado en JOINs
}

/**
 * Discriminated union para items completos
 * Usa el campo 'tipo' como discriminador
 */
export type ItemCompleto =
    | { tipo: 'producto'; item: Item; detalle: ItemProductoDetalle }
    | { tipo: 'servicio'; item: Item; detalle: ItemServicioDetalle }
    | { tipo: 'combo'; item: Item; detalle: ItemComboDetalle; items?: ComboItem[] };

/**
 * Type guard para verificar si es producto
 */
export function isProducto(item: Item): item is Item & { tipo: 'producto' } {
    return item.tipo === 'producto';
}

/**
 * Type guard para verificar si es servicio
 */
export function isServicio(item: Item): item is Item & { tipo: 'servicio' } {
    return item.tipo === 'servicio';
}

/**
 * Type guard para verificar si es combo
 */
export function isCombo(item: Item): item is Item & { tipo: 'combo' } {
    return item.tipo === 'combo';
}

/**
 * Helper para obtener item completo con detalles
 */
export function createItemCompleto(
    item: Item,
    detalle: ItemProductoDetalle | ItemServicioDetalle | ItemComboDetalle,
    comboItems?: ComboItem[]
): ItemCompleto {
    switch (item.tipo) {
        case 'producto':
            return { tipo: 'producto', item, detalle: detalle as ItemProductoDetalle };
        case 'servicio':
            return { tipo: 'servicio', item, detalle: detalle as ItemServicioDetalle };
        case 'combo':
            return { tipo: 'combo', item, detalle: detalle as ItemComboDetalle, items: comboItems };
    }
}
