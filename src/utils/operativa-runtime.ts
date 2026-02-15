import type { FastifyRequest } from 'fastify'
import sql from '../db-admin.js'
import { getOperativeConfig } from './config.js'
import { logAuditEvent } from './audit.js'
import { obtenerEmpresaIdPorPuntoVenta } from './empresa.js'

const ZONA_HORARIA_OPERATIVA = 'America/Argentina/Buenos_Aires'

type CajaActual = {
  id: string
  punto_venta_id: string
  empresa_id: string
  nombre: string
  abierta: boolean
  activa: boolean
  monto_inicial_actual: number
  fecha_apertura_actual: string | null
}

type ResultadoProcesoCaja = {
  empresaId: string
  cajaId: string
  cajaAbierta: boolean
  requiereDecisionCajaCerrada?: boolean
  requiereMontoInicialPrimeraVenta?: boolean
  puedeAbrirCaja?: boolean
  permitirFueraCaja?: boolean
  mensajeDecision?: string
  accionSugerida?: 'abrir' | 'fuera_caja'
}

type AccionCajaCerrada = 'abrir' | 'fuera_caja'

type RolUsuarioOperativo = {
  id: string
  rol_id: string | null
  rol_nombre: string | null
}

const obtenerZonaHorariaOperativa = (timezone: string | null | undefined): string => {
  if (!timezone) return ZONA_HORARIA_OPERATIVA

  try {
    new Intl.DateTimeFormat('es-AR', { timeZone: timezone }).format(new Date())
    return timezone
  } catch {
    return ZONA_HORARIA_OPERATIVA
  }
}

const formatearFechaLocal = (fecha: Date, zonaHoraria: string): string => {
  const texto = new Intl.DateTimeFormat('en-CA', {
    timeZone: zonaHoraria,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(fecha)
  return texto
}

const formatearHoraLocal = (fecha: Date, zonaHoraria: string): string => {
  const texto = new Intl.DateTimeFormat('es-AR', {
    timeZone: zonaHoraria,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(fecha)
  return texto.replace('.', ':')
}

const construirFechaCierreProgramadaLocal = (fechaOperativa: string, horaObjetivo: string): string => {
  return `${fechaOperativa} ${horaObjetivo}:00`
}

const obtenerRolUsuario = async (usuarioId: string): Promise<RolUsuarioOperativo | null> => {
  const usuarios = await sql<RolUsuarioOperativo[]>`
    SELECT u.id, u.rol_id, lower(r.nombre) as rol_nombre
    FROM usuarios u
    LEFT JOIN roles r ON r.id = u.rol_id
    WHERE u.id = ${usuarioId}
    LIMIT 1
  `
  return usuarios[0] ?? null
}

const estaDentroHorarioApertura = (horaApertura: string, ahora: Date, zonaHoraria: string): boolean => {
  const horaActual = formatearHoraLocal(ahora, zonaHoraria)
  return horaActual >= horaApertura
}

const debeIntentarCierreAutomatico = (caja: CajaActual, horaObjetivo: string, ahora: Date, zonaHoraria: string): boolean => {
  if (!caja.abierta || !caja.fecha_apertura_actual) return false

  const horaActual = formatearHoraLocal(ahora, zonaHoraria)
  if (horaActual < horaObjetivo) return false

  const apertura = new Date(caja.fecha_apertura_actual)
  const fechaHoy = formatearFechaLocal(ahora, zonaHoraria)
  const fechaApertura = formatearFechaLocal(apertura, zonaHoraria)

  if (fechaHoy > fechaApertura) {
    return true
  }

  if (fechaHoy < fechaApertura) {
    return false
  }

  const horaApertura = formatearHoraLocal(apertura, zonaHoraria)
  return horaApertura <= horaObjetivo
}

const obtenerCajaActivaPorPuntoVenta = async (empresaId: string, puntoVentaId: string): Promise<CajaActual> => {
  const cajas = await sql<CajaActual[]>`
    SELECT id, punto_venta_id, empresa_id, nombre, abierta, activa, monto_inicial_actual, fecha_apertura_actual
    FROM cajas
    WHERE punto_venta_id = ${puntoVentaId}
      AND empresa_id = ${empresaId}
      AND activa = true
    ORDER BY creado_en ASC
    LIMIT 1
  `

  if (cajas.length > 0) {
    return cajas[0]
  }

  const nuevas = await sql<CajaActual[]>`
    INSERT INTO cajas (punto_venta_id, empresa_id, nombre, es_virtual, activa)
    VALUES (${puntoVentaId}, ${empresaId}, 'Caja Virtual (Auto)', true, true)
    RETURNING id, punto_venta_id, empresa_id, nombre, abierta, activa, monto_inicial_actual, fecha_apertura_actual
  `

  return nuevas[0]
}

const aplicarPoliticaConsumosPendientesAlCerrar = async (parametros: {
  empresaId: string
  puntoVentaId: string
  cierreId: string
  regla: 'pendiente_siguiente_caja' | 'cobro_automatico_venta' | 'cobro_automatico_costo' | 'perdonado' | 'no_permitir_cierre'
  usuarioId?: string | null
  request?: FastifyRequest
  motivo: string
}) => {
  const consumosPendientes = await sql<
    { id: string; total_venta: number; total_costo: number }[]
  >`
    SELECT c.id, c.total_venta, c.total_costo
    FROM consumos_staff c
    JOIN puntos_venta pv ON pv.id = c.punto_venta_id
    WHERE pv.empresa_id = ${parametros.empresaId}
      AND c.punto_venta_id = ${parametros.puntoVentaId}
      AND c.estado_liquidacion = 'pendiente'
  `

  if (
    consumosPendientes.length === 0
    || parametros.regla === 'pendiente_siguiente_caja'
    || parametros.regla === 'no_permitir_cierre'
  ) {
    return {
      reglaAplicada: parametros.regla,
      cantidad: 0,
      montoTotal: 0,
    }
  }

  const reglaLiquidacion =
    parametros.regla === 'cobro_automatico_venta'
      ? 'precio_venta'
      : parametros.regla === 'cobro_automatico_costo'
        ? 'precio_costo'
        : 'perdonado'

  let montoTotal = 0
  await sql.begin(async (tx: any) => {
    for (const consumo of consumosPendientes) {
      const montoCobrado =
        parametros.regla === 'cobro_automatico_venta'
          ? Number(consumo.total_venta)
          : parametros.regla === 'cobro_automatico_costo'
            ? Number(consumo.total_costo)
            : 0

      montoTotal += montoCobrado

      await tx`
        INSERT INTO liquidaciones_consumo (
          consumo_id,
          admin_id,
          regla_aplicada,
          valor_regla,
          monto_cobrado,
          motivo,
          creado_en
        )
        VALUES (
          ${consumo.id},
          ${parametros.usuarioId ?? null},
          ${reglaLiquidacion},
          NULL,
          ${montoCobrado},
          ${parametros.motivo},
          NOW()
        )
      `

      const nuevoEstado = parametros.regla === 'perdonado' ? 'perdonado' : 'cobrado'
      await tx`
        UPDATE consumos_staff
        SET estado_liquidacion = ${nuevoEstado},
            liquidado_en = NOW()
        WHERE id = ${consumo.id}
      `
    }
  })

  await logAuditEvent({
    empresaId: parametros.empresaId,
    usuarioId: parametros.usuarioId ?? null,
    accion: 'consumos_resueltos_por_cierre',
    entidad: 'cierre_caja',
    entidadId: parametros.cierreId,
    metadata: {
      puntoVentaId: parametros.puntoVentaId,
      regla: parametros.regla,
      cantidad: consumosPendientes.length,
      montoTotal,
      motivo: parametros.motivo,
    },
    request: parametros.request,
  })

  return {
    reglaAplicada: parametros.regla,
    cantidad: consumosPendientes.length,
    montoTotal,
  }
}

const ejecutarCierreAutomaticoCaja = async (parametros: {
  empresaId: string
  puntoVentaId: string
  caja: CajaActual
  horaObjetivo: string
  reglaConsumos: 'pendiente_siguiente_caja' | 'cobro_automatico_venta' | 'cobro_automatico_costo' | 'perdonado' | 'no_permitir_cierre'
  zonaHoraria: string
  request?: FastifyRequest
}) => {
  if (!parametros.caja.fecha_apertura_actual) {
    return false
  }

  const fechaOperativa = formatearFechaLocal(new Date(parametros.caja.fecha_apertura_actual), parametros.zonaHoraria)

  const consumosPendientes = await sql<{ cantidad: number }[]>`
    SELECT COUNT(*)::int as cantidad
    FROM consumos_staff c
    JOIN puntos_venta pv ON pv.id = c.punto_venta_id
    WHERE pv.empresa_id = ${parametros.empresaId}
      AND c.punto_venta_id = ${parametros.puntoVentaId}
      AND c.estado_liquidacion = 'pendiente'
  `

  const cantidadConsumosPendientes = Number(consumosPendientes[0]?.cantidad ?? 0)
  if (parametros.reglaConsumos === 'no_permitir_cierre' && cantidadConsumosPendientes > 0) {
    return false
  }

  const control = await sql<{ id: string }[]>`
    INSERT INTO cierres_automaticos_control (
      caja_id,
      empresa_id,
      punto_venta_id,
      fecha_operativa,
      hora_objetivo
    )
    VALUES (
      ${parametros.caja.id},
      ${parametros.empresaId},
      ${parametros.puntoVentaId},
      ${fechaOperativa},
      ${parametros.horaObjetivo}
    )
    ON CONFLICT (caja_id, fecha_operativa, hora_objetivo) DO NOTHING
    RETURNING id
  `

  if (control.length === 0) {
    return false
  }

  const fueraCajaPendientes = await sql<{ total: number; cantidad: number }[]>`
    SELECT
      COALESCE(SUM(total), 0) as total,
      COUNT(*) as cantidad
    FROM transacciones
    WHERE punto_venta_id = ${parametros.puntoVentaId}
      AND empresa_id = ${parametros.empresaId}
      AND estado = 'confirmada'
      AND fuera_caja = true
      AND conciliada_en IS NULL
  `

  const totales = await sql<
    {
      total_ventas: number
      cantidad_transacciones: number
      total_efectivo: number
      total_tarjeta: number
      total_transferencia: number
    }[]
  >`
    SELECT
      COALESCE(SUM(total), 0) as total_ventas,
      COUNT(*) as cantidad_transacciones,
      COALESCE(SUM(CASE WHEN medio_pago_nombre ILIKE '%efectivo%' THEN total ELSE 0 END), 0) as total_efectivo,
      COALESCE(SUM(CASE WHEN medio_pago_nombre ILIKE '%tarjeta%' THEN total ELSE 0 END), 0) as total_tarjeta,
      COALESCE(SUM(CASE WHEN medio_pago_nombre ILIKE '%transferencia%' THEN total ELSE 0 END), 0) as total_transferencia
    FROM transacciones
    WHERE caja_id = ${parametros.caja.id}
      AND empresa_id = ${parametros.empresaId}
      AND creado_en >= ${parametros.caja.fecha_apertura_actual}
      AND estado = 'confirmada'
  `

  const totalFueraCajaPendiente = Number(fueraCajaPendientes[0]?.total ?? 0)
  const cantidadFueraCajaPendiente = Number(fueraCajaPendientes[0]?.cantidad ?? 0)
  const totalEfectivo = Number(totales[0]?.total_efectivo ?? 0)
  const montoInicial = Number(parametros.caja.monto_inicial_actual ?? 0)
  const incluirFueraCaja = true
  const montoEsperado = montoInicial + totalEfectivo + totalFueraCajaPendiente
  const montoReal = montoEsperado
  const fechaCierreProgramadaLocal = construirFechaCierreProgramadaLocal(fechaOperativa, parametros.horaObjetivo)

  const cierre = await sql<{ id: string }[]>`
    INSERT INTO cierres_caja (
      caja_id,
      punto_venta_id,
      empresa_id,
      cerrada_por_admin_id,
      fecha_operativa,
      fecha_apertura,
      fecha_cierre,
      monto_inicial,
      monto_esperado,
      monto_real,
      diferencia,
      total_ventas,
      total_efectivo,
      total_tarjeta,
      total_transferencia,
      cantidad_transacciones,
      observaciones,
      incluir_fuera_caja,
      fuera_caja_incluidas,
      total_fuera_caja_conciliado
    )
    VALUES (
      ${parametros.caja.id},
      ${parametros.puntoVentaId},
      ${parametros.empresaId},
      NULL,
      ${fechaOperativa},
      ${parametros.caja.fecha_apertura_actual},
      (${fechaCierreProgramadaLocal}::timestamp AT TIME ZONE ${parametros.zonaHoraria}),
      ${montoInicial},
      ${montoEsperado},
      ${montoReal},
      0,
      ${Number(totales[0]?.total_ventas ?? 0)},
      ${totalEfectivo},
      ${Number(totales[0]?.total_tarjeta ?? 0)},
      ${Number(totales[0]?.total_transferencia ?? 0)},
      ${Number(totales[0]?.cantidad_transacciones ?? 0) + cantidadFueraCajaPendiente},
      ${'Cierre automatico por configuracion operativa'},
      ${incluirFueraCaja},
      ${cantidadFueraCajaPendiente},
      ${totalFueraCajaPendiente}
    )
    ON CONFLICT (punto_venta_id, caja_id, fecha_operativa)
    DO UPDATE SET
      empresa_id = EXCLUDED.empresa_id,
      fecha_apertura = EXCLUDED.fecha_apertura,
      fecha_cierre = EXCLUDED.fecha_cierre,
      monto_inicial = EXCLUDED.monto_inicial,
      monto_esperado = EXCLUDED.monto_esperado,
      monto_real = EXCLUDED.monto_real,
      diferencia = EXCLUDED.diferencia,
      total_ventas = EXCLUDED.total_ventas,
      total_efectivo = EXCLUDED.total_efectivo,
      total_tarjeta = EXCLUDED.total_tarjeta,
      total_transferencia = EXCLUDED.total_transferencia,
      cantidad_transacciones = EXCLUDED.cantidad_transacciones,
      observaciones = EXCLUDED.observaciones,
      incluir_fuera_caja = EXCLUDED.incluir_fuera_caja,
      fuera_caja_incluidas = EXCLUDED.fuera_caja_incluidas,
      total_fuera_caja_conciliado = EXCLUDED.total_fuera_caja_conciliado
    RETURNING id
  `

  if (cantidadFueraCajaPendiente > 0) {
    await sql`
      UPDATE transacciones
      SET conciliada_en_cierre_id = ${cierre[0].id},
          conciliada_en = NOW()
      WHERE punto_venta_id = ${parametros.puntoVentaId}
        AND empresa_id = ${parametros.empresaId}
        AND estado = 'confirmada'
        AND fuera_caja = true
        AND conciliada_en IS NULL
    `
  }

  const resultadoConsumos = await aplicarPoliticaConsumosPendientesAlCerrar({
    empresaId: parametros.empresaId,
    puntoVentaId: parametros.puntoVentaId,
    cierreId: cierre[0].id,
    regla: parametros.reglaConsumos,
    motivo: 'Aplicacion automatica al cierre de caja',
    request: parametros.request,
  })

  await sql`
    UPDATE cajas
    SET abierta = false,
        monto_inicial_actual = 0,
        fecha_apertura_actual = NULL,
        actualizado_en = NOW()
    WHERE id = ${parametros.caja.id}
  `

  await sql`
    UPDATE cierres_automaticos_control
    SET cierre_id = ${cierre[0].id},
        actualizado_en = NOW()
    WHERE id = ${control[0].id}
  `

  await logAuditEvent({
    empresaId: parametros.empresaId,
    accion: 'caja_cierre_automatico',
    entidad: 'caja',
    entidadId: parametros.caja.id,
    metadata: {
      cierreId: cierre[0].id,
      horaObjetivo: parametros.horaObjetivo,
      totalFueraCajaConciliado: totalFueraCajaPendiente,
      consumosResueltos: resultadoConsumos,
    },
    request: parametros.request,
  })

  return true
}

export async function intentarCierreAutomaticoPuntoVenta(parametros: {
  puntoVentaId: string
  request?: FastifyRequest
  motivo?: string
}): Promise<boolean> {
  const empresaId = await obtenerEmpresaIdPorPuntoVenta(parametros.puntoVentaId)
  const configuracion = await getOperativeConfig(empresaId, parametros.puntoVentaId)
  const zonaHoraria = obtenerZonaHorariaOperativa(configuracion.regional?.timezone)
  const caja = await obtenerCajaActivaPorPuntoVenta(empresaId, parametros.puntoVentaId)

  if (
    configuracion.caja.cierre_automatico_habilitado
    && configuracion.caja.cierre_automatico_hora
    && debeIntentarCierreAutomatico(caja, configuracion.caja.cierre_automatico_hora, new Date(), zonaHoraria)
  ) {
    return ejecutarCierreAutomaticoCaja({
      empresaId,
      puntoVentaId: parametros.puntoVentaId,
      caja,
      horaObjetivo: configuracion.caja.cierre_automatico_hora,
      reglaConsumos: configuracion.consumos.al_cierre_sin_liquidar,
      zonaHoraria,
      request: parametros.request,
    })
  }

  return false
}

export async function procesarCierresAutomaticosPendientesEmpresa(parametros: {
  empresaId: string
  request?: FastifyRequest
  motivo?: string
}) {
  const puntosVenta = await sql<{ id: string }[]>`
    SELECT id
    FROM puntos_venta
    WHERE empresa_id = ${parametros.empresaId}
      AND activo = true
    ORDER BY nombre ASC
  `

  let cierresEjecutados = 0
  for (const puntoVenta of puntosVenta) {
    const cerrado = await intentarCierreAutomaticoPuntoVenta({
      puntoVentaId: puntoVenta.id,
      request: parametros.request,
      motivo: parametros.motivo,
    })
    if (cerrado) cierresEjecutados += 1
  }

  return {
    totalPuntosVenta: puntosVenta.length,
    cierresEjecutados,
  }
}

export async function procesarOperativaCajaEnMovimiento(parametros: {
  puntoVentaId: string
  usuarioId?: string
  request?: FastifyRequest
  motivo: string
  tipoOperacion?: 'venta' | 'consumo'
  accionCajaCerrada?: AccionCajaCerrada
  montoInicialApertura?: number
}): Promise<ResultadoProcesoCaja> {
  const empresaId = await obtenerEmpresaIdPorPuntoVenta(parametros.puntoVentaId)
  const configuracion = await getOperativeConfig(empresaId, parametros.puntoVentaId)
  const zonaHoraria = obtenerZonaHorariaOperativa(configuracion.regional?.timezone)

  let caja = await obtenerCajaActivaPorPuntoVenta(empresaId, parametros.puntoVentaId)

  if (
    configuracion.caja.cierre_automatico_habilitado
    && configuracion.caja.cierre_automatico_hora
    && debeIntentarCierreAutomatico(caja, configuracion.caja.cierre_automatico_hora, new Date(), zonaHoraria)
  ) {
    await ejecutarCierreAutomaticoCaja({
      empresaId,
      puntoVentaId: parametros.puntoVentaId,
      caja,
      horaObjetivo: configuracion.caja.cierre_automatico_hora,
      reglaConsumos: configuracion.consumos.al_cierre_sin_liquidar,
      zonaHoraria,
      request: parametros.request,
    })

    caja = await obtenerCajaActivaPorPuntoVenta(empresaId, parametros.puntoVentaId)
  }

  const usuario = parametros.usuarioId ? await obtenerRolUsuario(parametros.usuarioId) : null
  const rolPermitidoParaApertura =
    configuracion.caja.apertura_roles_permitidos.length === 0
      || (!!usuario?.rol_id && configuracion.caja.apertura_roles_permitidos.includes(usuario.rol_id))

  const abrirCaja = async (montoInicial = 0) => {
    const montoInicialAplicado = Number.isFinite(montoInicial) ? Math.max(0, montoInicial) : 0

    await sql`
      UPDATE cajas
      SET abierta = true,
          monto_inicial_actual = ${montoInicialAplicado},
          fecha_apertura_actual = NOW(),
          actualizado_en = NOW()
      WHERE id = ${caja.id}
    `

    await logAuditEvent({
      empresaId,
      usuarioId: parametros.usuarioId ?? null,
      accion: 'caja_apertura_automatica',
      entidad: 'caja',
      entidadId: caja.id,
      metadata: {
        puntoVentaId: parametros.puntoVentaId,
        motivo: parametros.motivo,
        montoInicial: montoInicialAplicado,
      },
      request: parametros.request,
    })

    caja = {
      ...caja,
      abierta: true,
      monto_inicial_actual: montoInicialAplicado,
      fecha_apertura_actual: new Date().toISOString(),
    }
  }

  if (!caja.abierta && configuracion.caja.apertura_modo === 'hora_programada' && configuracion.caja.apertura_hora) {
    if (estaDentroHorarioApertura(configuracion.caja.apertura_hora, new Date(), zonaHoraria)) {
      await abrirCaja(parametros.montoInicialApertura ?? 0)
    }
  }

  if (!caja.abierta && configuracion.caja.apertura_modo === 'primera_venta') {
    if ((parametros.tipoOperacion || 'venta') === 'venta') {
      if (parametros.accionCajaCerrada !== 'abrir') {
        return {
          empresaId,
          cajaId: caja.id,
          cajaAbierta: false,
          requiereDecisionCajaCerrada: true,
          requiereMontoInicialPrimeraVenta: true,
          puedeAbrirCaja: true,
          permitirFueraCaja: false,
          accionSugerida: 'abrir',
          mensajeDecision: 'La caja esta cerrada y este punto de venta abre por primera venta. Deseas ingresar monto inicial?',
        }
      }

      await abrirCaja(parametros.montoInicialApertura ?? 0)
    } else {
      await abrirCaja(parametros.montoInicialApertura ?? 0)
    }
  }

  if (!caja.abierta && configuracion.caja.apertura_modo === 'manual') {
    if (parametros.accionCajaCerrada === 'abrir') {
      if (!rolPermitidoParaApertura) {
        return {
          empresaId,
          cajaId: caja.id,
          cajaAbierta: false,
          requiereDecisionCajaCerrada: true,
          puedeAbrirCaja: false,
          permitirFueraCaja: configuracion.caja.permitir_ventas_fuera_caja,
          accionSugerida: configuracion.caja.permitir_ventas_fuera_caja ? 'fuera_caja' : 'abrir',
          mensajeDecision: configuracion.caja.permitir_ventas_fuera_caja
            ? 'No posees rol para abrir caja. Contacta a un encargado para abrirla o continua registrando fuera de caja.'
            : 'No posees rol para abrir caja y operar fuera de caja esta deshabilitado. Contacta a un encargado.',
        }
      }

      await abrirCaja(parametros.montoInicialApertura ?? 0)
    } else if (parametros.accionCajaCerrada === 'fuera_caja') {
      if (!configuracion.caja.permitir_ventas_fuera_caja) {
        const error = new Error('La operacion fuera de caja esta deshabilitada por configuracion.') as Error & { codigo?: string }
        error.codigo = 'FUERA_CAJA_DESHABILITADO'
        throw error
      }
      // Se mantiene cerrada y la operación irá fuera de caja.
    } else {
      if (configuracion.caja.accion_caja_cerrada === 'bloquear') {
        const error = new Error('Caja cerrada. Debe abrirse antes de operar.') as Error & { codigo?: string }
        error.codigo = 'CAJA_CERRADA_BLOQUEADA'
        throw error
      }

      if (configuracion.caja.accion_caja_cerrada === 'fuera_caja') {
        if (!configuracion.caja.permitir_ventas_fuera_caja) {
          if (rolPermitidoParaApertura) {
            return {
              empresaId,
              cajaId: caja.id,
              cajaAbierta: false,
              requiereDecisionCajaCerrada: true,
              puedeAbrirCaja: true,
              permitirFueraCaja: false,
              accionSugerida: 'abrir',
              mensajeDecision: 'La caja esta cerrada y operar fuera de caja esta deshabilitado. Debes abrir la caja para continuar.',
            }
          }

          const error = new Error('Caja cerrada y operar fuera de caja esta deshabilitado. Solicita a un rol habilitado que abra la caja.') as Error & { codigo?: string }
          error.codigo = 'CAJA_CERRADA_BLOQUEADA'
          throw error
        }
        // continuar sin abrir; queda fuera de caja
      } else {
        return {
          empresaId,
          cajaId: caja.id,
          cajaAbierta: false,
          requiereDecisionCajaCerrada: true,
          puedeAbrirCaja: rolPermitidoParaApertura,
          permitirFueraCaja: configuracion.caja.permitir_ventas_fuera_caja,
          accionSugerida: rolPermitidoParaApertura ? 'abrir' : (configuracion.caja.permitir_ventas_fuera_caja ? 'fuera_caja' : 'abrir'),
          mensajeDecision: rolPermitidoParaApertura
            ? (configuracion.caja.permitir_ventas_fuera_caja
              ? 'La caja esta cerrada. Deseas abrirla o continuar fuera de caja?'
              : 'La caja esta cerrada y operar fuera de caja esta deshabilitado. Debes abrirla para continuar.')
            : (configuracion.caja.permitir_ventas_fuera_caja
              ? 'No posees rol para abrir caja. Contacta a un encargado para abrirla o continua registrando fuera de caja.'
              : 'No posees rol para abrir caja y operar fuera de caja esta deshabilitado. Contacta a un encargado.'),
        }
      }
    }
  }

  return {
    empresaId,
    cajaId: caja.id,
    cajaAbierta: Boolean(caja.abierta),
  }
}

export async function aplicarPoliticaConsumosAlCerrarCaja(parametros: {
  empresaId: string
  puntoVentaId: string
  cierreId: string
  usuarioId?: string | null
  request?: FastifyRequest
}) {
  const configuracion = await getOperativeConfig(parametros.empresaId, parametros.puntoVentaId)
  return aplicarPoliticaConsumosPendientesAlCerrar({
    empresaId: parametros.empresaId,
    puntoVentaId: parametros.puntoVentaId,
    cierreId: parametros.cierreId,
    regla: configuracion.consumos.al_cierre_sin_liquidar,
    usuarioId: parametros.usuarioId ?? null,
    request: parametros.request,
    motivo: 'Aplicacion de regla al cierre manual de caja',
  })
}
