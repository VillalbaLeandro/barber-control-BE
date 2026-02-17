import { deepMerge, normalizeConfigInput } from '../utils/config-helpers'

describe('config helpers', () => {
  test('normalizeConfigInput returns object from json string', () => {
    const result = normalizeConfigInput('{"caja":{"apertura_modo":"manual"}}')
    expect(result).toEqual({ caja: { apertura_modo: 'manual' } })
  })

  test('normalizeConfigInput returns empty object for invalid json', () => {
    const result = normalizeConfigInput('{invalid')
    expect(result).toEqual({})
  })

  test('deepMerge merges nested objects preserving base values', () => {
    const base = {
      caja: {
        apertura_modo: 'manual',
        permitir_ventas_fuera_caja: true,
      },
      consumos: {
        al_cierre_sin_liquidar: 'pendiente_siguiente_caja',
      },
    }

    const override = {
      caja: {
        permitir_ventas_fuera_caja: false,
      },
    }

    const merged = deepMerge(base, override)

    expect(merged).toEqual({
      caja: {
        apertura_modo: 'manual',
        permitir_ventas_fuera_caja: false,
      },
      consumos: {
        al_cierre_sin_liquidar: 'pendiente_siguiente_caja',
      },
    })
  })
})
