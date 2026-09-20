"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — idempotencia del CRM de Entregas (src/services/entregas.js)
//
// Estas guardas YA existían en el código (WHERE estado_entrega='PENDIENTE'
// / estado_pago='PENDIENTE_DE_PAGO') — este archivo es la prueba de
// regresión que faltaba, para que un cambio futuro no las rompa sin que
// nadie se dé cuenta. Mockea pool/pool.connect, nunca toca Postgres real
// ni crea una entrega de verdad.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const { marcarEntregado, marcarCancelado, registrarPago } = require("../src/services/entregas");

test("marcarEntregado: usa el guard WHERE estado_entrega='PENDIENTE'", async (t) => {
    let sqlUpdate = "";
    t.mock.method(pool, "query", async (sql) => {
        if (/UPDATE entregas\b/.test(sql)) {
            sqlUpdate = sql;
            return { rows: [{ id: 1, codigo: "E-1000", estado_entrega: "ENTREGADO" }] };
        }
        return { rows: [] }; // INSERT INTO entregas_historial
    });
    await marcarEntregado(1, "Panel admin");
    assert.match(sqlUpdate, /estado_entrega\s*=\s*'PENDIENTE'/);
});

test("marcarEntregado: primera vez (estaba PENDIENTE) -> devuelve la entrega actualizada", async (t) => {
    t.mock.method(pool, "query", async (sql) => {
        if (/UPDATE entregas/.test(sql)) return { rows: [{ id: 1, codigo: "E-1000", estado_entrega: "ENTREGADO" }] };
        return { rows: [] };
    });
    const r = await marcarEntregado(1, "Panel admin");
    assert.equal(r.estado_entrega, "ENTREGADO");
});

test("marcarEntregado: doble clic / segunda llamada (ya no está PENDIENTE) -> null, no reabre ni renotifica", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [] })); // el WHERE ya no matchea
    assert.equal(await marcarEntregado(1, "Panel admin"), null);
});

test("marcarEntregado: entrega inexistente -> null", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [] }));
    assert.equal(await marcarEntregado(999999, "x"), null);
});

test("marcarEntregado: error de DB -> null, nunca revienta", async (t) => {
    t.mock.method(pool, "query", async () => { throw new Error("DB caída"); });
    assert.equal(await marcarEntregado(1, "x"), null);
});

test("marcarCancelado: usa el guard WHERE estado_entrega='PENDIENTE'", async (t) => {
    let sqlUpdate = "";
    t.mock.method(pool, "query", async (sql) => {
        if (/UPDATE entregas\b/.test(sql)) {
            sqlUpdate = sql;
            return { rows: [{ id: 1, codigo: "E-1000", estado_entrega: "CANCELADO" }] };
        }
        return { rows: [] };
    });
    await marcarCancelado(1, "cliente se arrepintió");
    assert.match(sqlUpdate, /estado_entrega\s*=\s*'PENDIENTE'/);
});

test("marcarCancelado: ya entregada -> no se puede cancelar (null)", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [] }));
    assert.equal(await marcarCancelado(1, "motivo"), null);
});

test("registrarPago: sin entregaIds -> null, ni siquiera abre conexión", async (t) => {
    let seLlamoConnect = false;
    t.mock.method(pool, "connect", async () => { seLlamoConnect = true; return {}; });
    assert.equal(await registrarPago([], {}), null);
    assert.equal(await registrarPago(null, {}), null);
    assert.equal(seLlamoConnect, false);
});

test("registrarPago: solo marca PAGADO las entregas que están en PENDIENTE_DE_PAGO (guard en el UPDATE)", async (t) => {
    let sqlUpdate = "";
    const client = {
        query: async (sql, params) => {
            if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return {};
            if (/nextval/.test(sql)) return { rows: [{ n: 7 }] };
            if (/INSERT INTO entregas_pagos/.test(sql)) return { rows: [{ id: 99, codigo: "P-007" }] };
            if (/UPDATE entregas/.test(sql)) {
                sqlUpdate = sql;
                return { rows: [{ id: 1, codigo: "E-1000" }] }; // solo la que sí calificaba
            }
            return { rows: [] };
        },
        release: () => {}
    };
    t.mock.method(pool, "connect", async () => client);
    t.mock.method(pool, "query", async () => ({ rows: [] })); // registrarHistorial

    const resultado = await registrarPago([1, 2], { cantidadEnviada: 10, monedaPago: "USDT" });
    assert.match(sqlUpdate, /estado_pago\s*=\s*'PENDIENTE_DE_PAGO'/);
    assert.equal(resultado.entregas.length, 1); // el id "2" (hipotético ya pagado/cancelado) se ignoró en silencio
});

test("registrarPago: error de DB -> ROLLBACK y null, nunca deja el pago a medias", async (t) => {
    let seHizoRollback = false;
    const client = {
        query: async (sql) => {
            if (sql === "BEGIN") return {};
            if (sql === "ROLLBACK") { seHizoRollback = true; return {}; }
            throw new Error("DB caída a mitad del pago");
        },
        release: () => {}
    };
    t.mock.method(pool, "connect", async () => client);
    const resultado = await registrarPago([1], { cantidadEnviada: 10 });
    assert.equal(resultado, null);
    assert.equal(seHizoRollback, true);
});
