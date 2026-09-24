"use strict";

const pool = require("../../db");
const { montosTransferencia } = require("./operadores");

const MONEDAS = Object.freeze(["CUP", "USD", "MLC"]);
const ESTADOS = new Set(["pendiente", "confirmada", "completada", "expirada", "rechazada"]);

function fechaValida(valor) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(valor || ""));
}

function construirTotales(transferencias) {
    const totales = { transferencias: transferencias.length, brl: 0, CUP: 0, USD: 0, MLC: 0 };
    for (const fila of transferencias) {
        totales.brl += Number(fila.brl) || 0;
        if (MONEDAS.includes(fila.moneda)) totales[fila.moneda] += Number(fila.destino) || 0;
    }
    return totales;
}

function construirCierre(movimientos, saldosIniciales) {
    const cierre = Object.fromEntries(MONEDAS.map(moneda => [moneda, {
        moneda,
        saldoInicial: Number(saldosIniciales[moneda]) || 0,
        cargas: 0,
        ajustes: 0,
        transferido: 0,
        reintegros: 0,
        saldoFinal: Number(saldosIniciales[moneda]) || 0,
        transferencias: 0
    }]));

    for (const movimiento of movimientos) {
        const item = cierre[movimiento.moneda];
        if (!item) continue;
        const monto = Number(movimiento.monto) || 0;
        if (movimiento.tipo === "carga") item.cargas += monto;
        if (movimiento.tipo === "ajuste") item.ajustes += monto;
        if (movimiento.tipo === "descuento") {
            item.transferido += Math.abs(monto);
            item.transferencias += 1;
        }
        if (movimiento.tipo === "reintegro") item.reintegros += monto;
        item.saldoFinal += monto;
    }
    return MONEDAS.map(moneda => cierre[moneda]);
}

async function obtenerInforme({ operadorId, desde, hasta, moneda, estado }) {
    const id = Number(operadorId);
    const monedaFinal = String(moneda || "").toUpperCase();
    const estadoFinal = String(estado || "").toLowerCase();
    if (!Number.isInteger(id) || id <= 0) return { error: "Selecciona un operador" };
    if (!fechaValida(desde) || !fechaValida(hasta) || desde > hasta) return { error: "Período inválido" };
    if (monedaFinal && !MONEDAS.includes(monedaFinal)) return { error: "Moneda inválida" };
    if (estadoFinal && !ESTADOS.has(estadoFinal)) return { error: "Estado inválido" };

    const operador = await pool.query("SELECT id, nombre FROM operadores WHERE id = $1", [id]);
    if (!operador.rows[0]) return { error: "Operador no encontrado" };

    const parametros = [id, desde, hasta];
    const filtros = [
        "m.operador_id = $1",
        "m.tipo = 'descuento'",
        "m.created_at >= ($2::date AT TIME ZONE 'America/Bahia')",
        "m.created_at < (($3::date + 1) AT TIME ZONE 'America/Bahia')"
    ];
    if (monedaFinal) { parametros.push(monedaFinal); filtros.push(`m.moneda = $${parametros.length}`); }
    if (estadoFinal) { parametros.push(estadoFinal); filtros.push(`o.status = $${parametros.length}`); }

    const transferenciasResult = await pool.query(`
        SELECT DISTINCT ON (m.operation_id)
            m.created_at AS procesada_at, m.operation_id, m.moneda,
            m.saldo_anterior, ABS(m.monto) AS debito, m.saldo_posterior,
            o.phone, o.nombre, o.titular, o.monto, o.cup, o.tarjeta, o.tipo, o.status,
            op.id AS operador_id, op.nombre AS operador_nombre
        FROM operador_movimientos m
        JOIN operations o ON o.id = m.operation_id
        JOIN operadores op ON op.id = m.operador_id
        WHERE ${filtros.join(" AND ")}
        ORDER BY m.operation_id, m.created_at DESC
    `, parametros);

    const transferencias = transferenciasResult.rows
        .map(fila => {
            const importes = montosTransferencia(fila);
            return { ...fila, brl: importes?.brl ?? null, destino: importes?.destino ?? null };
        })
        .sort((a, b) => new Date(b.procesada_at) - new Date(a.procesada_at));

    const movimientosResult = await pool.query(`
        SELECT moneda, monto, tipo
        FROM operador_movimientos
        WHERE operador_id = $1
          AND created_at >= ($2::date AT TIME ZONE 'America/Bahia')
          AND created_at < (($3::date + 1) AT TIME ZONE 'America/Bahia')
        ORDER BY created_at ASC, id ASC
    `, [id, desde, hasta]);
    const inicialesResult = await pool.query(`
        SELECT DISTINCT ON (moneda) moneda, saldo_posterior
        FROM operador_movimientos
        WHERE operador_id = $1
          AND created_at < ($2::date AT TIME ZONE 'America/Bahia')
        ORDER BY moneda, created_at DESC, id DESC
    `, [id, desde]);
    const saldosIniciales = Object.fromEntries(inicialesResult.rows.map(fila => [fila.moneda, fila.saldo_posterior]));

    return {
        operador: operador.rows[0],
        periodo: { desde, hasta },
        filtros: { moneda: monedaFinal || null, estado: estadoFinal || null },
        transferencias,
        totales: construirTotales(transferencias),
        cierre: construirCierre(movimientosResult.rows, saldosIniciales)
    };
}

module.exports = { obtenerInforme, construirTotales, construirCierre };
