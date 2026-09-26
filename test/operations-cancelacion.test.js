"use strict";

// Cancelación de transferencias desde el CRM (operations.cancelarOperacion).
// Mockea pool.query y zapi.enviarMensaje: nunca toca Postgres ni Z-API reales.

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const zapi = require("../src/services/zapi");
const { cancelarOperacion } = require("../src/services/operations");
const { mensajeCancelarOperacion } = require("../src/services/operation-messages");

// Simula una fila de operations; el UPDATE respeta el guard de estado como Postgres.
function mockOperacion(t, fila) {
    const sqls = [];
    t.mock.method(pool, "query", async (sql, params) => {
        sqls.push({ sql: String(sql), params });
        if (/^\s*SELECT \* FROM operations WHERE id/.test(sql)) return { rows: fila ? [{ ...fila }] : [] };
        if (/UPDATE operations/.test(sql)) {
            if (!fila || !params[2].includes(fila.status)) return { rows: [] };
            Object.assign(fila, { status: "cancelada", motivo_cancelacion: params[1], cancelada_at: new Date() });
            return { rows: [{ ...fila }] };
        }
        throw new Error(`Consulta inesperada: ${sql}`);
    });
    return sqls;
}

const base = { id: 12, phone: "5511999990000", monto: 300, cup: 33000, tipo: "brl_cup" };

for (const status of ["pendiente", "confirmada"]) {
    test(`${status} -> cancelada con motivo y fecha, sin tocar saldos`, async t => {
        const fila = { ...base, status };
        const sqls = mockOperacion(t, fila);
        const envio = t.mock.method(zapi, "enviarMensaje", async () => true);
        const r = await cancelarOperacion(12, "  Cliente desistió  ");
        assert.equal(r.operacion.status, "cancelada");
        assert.equal(r.operacion.motivo_cancelacion, "Cliente desistió");
        assert.ok(r.operacion.cancelada_at);
        assert.equal(r.notificado, true);
        assert.ok(sqls.every(q => !/operador_movimientos|DELETE/i.test(q.sql)));
        assert.equal(envio.mock.calls[0].arguments[1], "❌ Tu operación #12 fue cancelada.");
    });
}

test("completada se rechaza (requiere flujo de reversión) y no se actualiza", async t => {
    const sqls = mockOperacion(t, { ...base, status: "completada" });
    const envio = t.mock.method(zapi, "enviarMensaje", async () => true);
    const r = await cancelarOperacion(12, "error");
    assert.equal(r.code, "COMPLETADA");
    assert.ok(!sqls.some(q => /UPDATE/.test(q.sql)));
    assert.equal(envio.mock.callCount(), 0);
});

test("doble cancelación: la segunda se rechaza y no renotifica", async t => {
    const fila = { ...base, status: "pendiente" };
    mockOperacion(t, fila);
    const envio = t.mock.method(zapi, "enviarMensaje", async () => true);
    assert.equal((await cancelarOperacion(12, "duplicada")).operacion.status, "cancelada");
    const segunda = await cancelarOperacion(12, "duplicada");
    assert.equal(segunda.code, "YA_CANCELADA");
    assert.equal(envio.mock.callCount(), 1);
});

test("carrera: si el estado cambió antes del UPDATE, no cancela", async t => {
    const fila = { ...base, status: "confirmada" };
    t.mock.method(pool, "query", async sql => /^\s*SELECT/.test(sql) ? { rows: [{ ...fila }] } : { rows: [] });
    const envio = t.mock.method(zapi, "enviarMensaje", async () => true);
    assert.equal((await cancelarOperacion(12, "x")).code, "NO_CANCELABLE");
    assert.equal(envio.mock.callCount(), 0);
});

test("motivo obligatorio: vacío o solo espacios no consulta ni actualiza", async t => {
    const sqls = mockOperacion(t, { ...base, status: "pendiente" });
    for (const motivo of [undefined, "", "   "]) assert.equal((await cancelarOperacion(12, motivo)).code, "MOTIVO_REQUERIDO");
    assert.equal(sqls.length, 0);
});

test("solo transferencias: una entrega de efectivo no se cancela aquí", async t => {
    mockOperacion(t, { ...base, tipo: "cup_efectivo", status: "pendiente" });
    assert.equal((await cancelarOperacion(12, "x")).code, "NO_TRANSFERENCIA");
});

test("fallo de WhatsApp (false o excepción) no revierte la cancelación", async t => {
    for (const falla of [async () => false, async () => { throw new Error("Z-API caída"); }]) {
        const fila = { ...base, status: "pendiente" };
        const sqls = mockOperacion(t, fila);
        t.mock.method(zapi, "enviarMensaje", falla);
        const errores = t.mock.method(console, "error", () => {});
        const r = await cancelarOperacion(12, "sin fondos");
        assert.equal(r.operacion.status, "cancelada");
        assert.equal(r.notificado, false);
        assert.equal(fila.status, "cancelada");
        assert.equal(sqls.filter(q => /UPDATE/.test(q.sql)).length, 1);
        assert.ok(errores.mock.calls.some(c => /cancelación de la operación #12/.test(c.arguments[0])));
        t.mock.restoreAll();
    }
});

test("mensaje al cliente: solo ID + cancelada, sin motivo", () => {
    assert.equal(mensajeCancelarOperacion({ id: 7, motivo_cancelacion: "fraude" }), "❌ Tu operación #7 fue cancelada.");
});
