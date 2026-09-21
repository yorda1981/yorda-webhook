"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const operations = require("../src/services/operations");
const entregas = require("../src/services/entregas");
const { finalizarEntrega } = require("../src/services/entregas-coordinator");
const { mensajeCompletarOperacion } = require("../src/services/operation-messages");

test("Transferencia conserva su transición general y su mensaje normal", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [{ id: 1, tipo: "brl_cup", status: "completada" }] }));
    const op = await operations.completarOperacion(1);
    assert.equal(op.status, "completada");
    assert.match(mensajeCompletarOperacion(op), /transferencia fue completada/i);
});

test("Recarga conserva su transición general y su mensaje propio", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [{ id: 2, tipo: "recarga_nacional", status: "completada" }] }));
    const op = await operations.completarOperacion(2);
    assert.equal(op.status, "completada");
    assert.match(mensajeCompletarOperacion(op), /recarga Nacional fue completada/i);
});

test("Entrega no puede completarse por el circuito general", async (t) => {
    let sql = "";
    t.mock.method(pool, "query", async (q) => { sql = q; return { rows: [] }; });
    assert.equal(await operations.completarOperacion(3), null);
    assert.match(sql, /tipo NOT IN \('cup_efectivo', 'usd_efectivo'\)/);
    assert.equal(mensajeCompletarOperacion({ tipo: "cup_efectivo" }), null);
});

test("ENTREGADO sincroniza operation en la misma transacción y deja de ser elegible para avisos", async (t) => {
    const sqls = [];
    const entrega = { id: 10, codigo: "E-1010", operation_id: 33, phone: "5511999", estado_entrega: "ENTREGADO" };
    t.mock.method(pool, "connect", async () => ({
        query: async (sql) => {
            sqls.push(sql);
            if (/UPDATE entregas/.test(sql)) return { rows: [entrega] };
            return { rows: [] };
        }, release() {}
    }));
    const r = await entregas.marcarEntregado(10, "Panel");
    assert.equal(r.estado_entrega, "ENTREGADO");
    assert.ok(sqls.some(s => /UPDATE operations[\s\S]*status = 'completada'/.test(s)));
    assert.ok(sqls.includes("BEGIN") && sqls.includes("COMMIT"));
    assert.match(entregas.obtenerEntregasPendientesParaAviso.toString(), /estado_entrega = 'PENDIENTE'/);
});

test("coordinador envía exactamente un mensaje final; retry/doble click no duplica", async () => {
    const entrega = { id: 10, codigo: "E-1010", phone: "5511999" };
    let transiciones = 0;
    const mensajes = [];
    const deps = {
        marcarEntregado: async () => (++transiciones === 1 ? entrega : null),
        enviarSeguro: async (phone, msg) => { mensajes.push({ phone, msg }); return true; }
    };
    assert.ok(await finalizarEntrega(10, "Panel", deps));
    assert.equal(await finalizarEntrega(10, "Panel", deps), null);
    assert.equal(mensajes.length, 1);
    assert.match(mensajes[0].msg, /entrega E-1010 fue completada/i);
});

test("CANCELADO sincroniza la operation como rechazada y queda fuera de avisos pendientes", async (t) => {
    const sqls = [];
    t.mock.method(pool, "connect", async () => ({
        query: async (sql) => {
            sqls.push(sql);
            if (/UPDATE entregas/.test(sql)) return { rows: [{ id: 11, codigo: "E-1011", operation_id: 34, estado_entrega: "CANCELADO" }] };
            return { rows: [] };
        }, release() {}
    }));
    const r = await entregas.marcarCancelado(11, "cancelada");
    assert.equal(r.estado_entrega, "CANCELADO");
    assert.ok(sqls.some(s => /UPDATE operations[\s\S]*status = 'rechazada'/.test(s)));
    assert.match(entregas.obtenerEntregasPendientesParaAviso.toString(), /estado_entrega = 'PENDIENTE'/);
});
