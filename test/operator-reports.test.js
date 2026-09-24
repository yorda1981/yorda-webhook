"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const reports = require("../src/services/operator-reports");

test("cierre separa monedas y clasifica cargas, ajustes, descuentos y reintegros", () => {
    const cierre = reports.construirCierre([
        { moneda: "CUP", tipo: "carga", monto: 100000 },
        { moneda: "CUP", tipo: "descuento", monto: -327500 },
        { moneda: "CUP", tipo: "ajuste", monto: -10000 },
        { moneda: "USD", tipo: "descuento", monto: -100 },
        { moneda: "USD", tipo: "reintegro", monto: 100 }
    ], { CUP: 500000, USD: 200, MLC: 50 });

    assert.deepEqual(cierre[0], {
        moneda: "CUP", saldoInicial: 500000, cargas: 100000, ajustes: -10000,
        transferido: 327500, reintegros: 0, saldoFinal: 262500, transferencias: 1
    });
    assert.equal(cierre[1].saldoFinal, 200);
    assert.equal(cierre[1].transferencias, 1);
    assert.equal(cierre[2].saldoFinal, 50);
});

test("totales nunca mezclan CUP, USD y MLC; cargas y ajustes no entran", () => {
    const totales = reports.construirTotales([
        { moneda: "CUP", brl: 300, destino: 33000 },
        { moneda: "USD", brl: 560, destino: 100 },
        { moneda: "MLC", brl: 270, destino: 50 }
    ]);
    assert.deepEqual(totales, { transferencias: 3, brl: 1130, CUP: 33000, USD: 100, MLC: 50 });
});

test("informe usa el movimiento de descuento del operador real y filtros del período", async t => {
    const consultas = [];
    t.mock.method(pool, "query", async (sql, params) => {
        const q = String(sql).replace(/\s+/g, " ").trim();
        consultas.push({ q, params });
        if (q.startsWith("SELECT id, nombre FROM operadores")) return { rows: [{ id: 7, nombre: "Ana" }] };
        if (q.includes("SELECT DISTINCT ON (m.operation_id)")) return { rows: [{
            procesada_at: "2026-09-24T12:00:00Z", operation_id: 44, moneda: "USD",
            saldo_anterior: 200, debito: 100, saldo_posterior: 100,
            phone: "5511999", nombre: "Cliente", titular: "", monto: 560, cup: 100,
            tarjeta: "1234", tipo: "usd_transferencia", status: "completada",
            operador_id: 7, operador_nombre: "Ana"
        }] };
        if (q.startsWith("SELECT moneda, monto, tipo")) return { rows: [{ moneda: "USD", monto: -100, tipo: "descuento" }] };
        if (q.startsWith("SELECT DISTINCT ON (moneda)")) return { rows: [{ moneda: "USD", saldo_posterior: 200 }] };
        throw new Error(`Consulta inesperada: ${q}`);
    });

    const r = await reports.obtenerInforme({ operadorId: "7", desde: "2026-09-01", hasta: "2026-09-30", moneda: "USD", estado: "completada" });
    assert.equal(r.transferencias.length, 1);
    assert.equal(r.transferencias[0].brl, 560);
    assert.equal(r.transferencias[0].destino, 100);
    assert.deepEqual(r.totales, { transferencias: 1, brl: 560, CUP: 0, USD: 100, MLC: 0 });
    assert.equal(r.cierre.find(c => c.moneda === "USD").saldoFinal, 100);
    const sqlTransferencias = consultas.find(c => c.q.includes("m.tipo = 'descuento'"));
    assert.match(sqlTransferencias.q, /DISTINCT ON \(m\.operation_id\)/);
    assert.match(sqlTransferencias.q, /JOIN operations o ON o\.id = m\.operation_id/);
    assert.deepEqual(sqlTransferencias.params, [7, "2026-09-01", "2026-09-30", "USD", "completada"]);
});

test("informe rechaza operador, período, moneda o estado inválidos sin consultar", async t => {
    let llamadas = 0;
    t.mock.method(pool, "query", async () => { llamadas++; return { rows: [] }; });
    assert.ok((await reports.obtenerInforme({ operadorId: "", desde: "2026-09-01", hasta: "2026-09-30" })).error);
    assert.ok((await reports.obtenerInforme({ operadorId: "1", desde: "2026-10-01", hasta: "2026-09-30" })).error);
    assert.ok((await reports.obtenerInforme({ operadorId: "1", desde: "2026-09-01", hasta: "2026-09-30", moneda: "BRL" })).error);
    assert.ok((await reports.obtenerInforme({ operadorId: "1", desde: "2026-09-01", hasta: "2026-09-30", estado: "inventado" })).error);
    assert.equal(llamadas, 0);
});
