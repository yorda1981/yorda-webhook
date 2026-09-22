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

function mockTransicion(t, responderUpdateEntrega) {
    const consultas = [];
    const client = {
        query: async (sql, params = []) => {
            consultas.push({ sql, params });
            if (/UPDATE entregas\b/.test(sql)) return responderUpdateEntrega(sql, params);
            return { rows: [] };
        },
        release() {}
    };
    t.mock.method(pool, "connect", async () => client);
    return consultas;
}

test("marcarEntregado: usa el guard WHERE estado_entrega='PENDIENTE'", async (t) => {
    let sqlUpdate = "";
    mockTransicion(t, async (sql) => {
        sqlUpdate = sql;
        return { rows: [{ id: 1, codigo: "E-1000", estado_entrega: "ENTREGADO" }] };
    });
    await marcarEntregado(1, "Panel admin");
    assert.match(sqlUpdate, /estado_entrega\s*=\s*'PENDIENTE'/);
});

test("marcarEntregado: primera vez (estaba PENDIENTE) -> devuelve la entrega actualizada", async (t) => {
    mockTransicion(t, async () => ({ rows: [{ id: 1, codigo: "E-1000", estado_entrega: "ENTREGADO" }] }));
    const r = await marcarEntregado(1, "Panel admin");
    assert.equal(r.estado_entrega, "ENTREGADO");
});

test("marcarEntregado: doble clic / segunda llamada (ya no está PENDIENTE) -> null, no reabre ni renotifica", async (t) => {
    mockTransicion(t, async () => ({ rows: [] }));
    assert.equal(await marcarEntregado(1, "Panel admin"), null);
});

test("marcarEntregado: entrega inexistente -> null", async (t) => {
    mockTransicion(t, async () => ({ rows: [] }));
    assert.equal(await marcarEntregado(999999, "x"), null);
});

test("marcarEntregado: error de DB -> null, nunca revienta", async (t) => {
    const client = { query: async (sql) => { if (sql === "ROLLBACK") return {}; throw new Error("DB caída"); }, release() {} };
    t.mock.method(pool, "connect", async () => client);
    assert.equal(await marcarEntregado(1, "x"), null);
});

test("marcarCancelado: usa el guard WHERE estado_entrega='PENDIENTE'", async (t) => {
    let sqlUpdate = "";
    mockTransicion(t, async (sql) => {
        sqlUpdate = sql;
        return { rows: [{ id: 1, codigo: "E-1000", estado_entrega: "CANCELADO" }] };
    });
    await marcarCancelado(1, "cliente se arrepintió");
    assert.match(sqlUpdate, /estado_entrega\s*=\s*'PENDIENTE'/);
});

test("marcarCancelado: ya entregada -> no se puede cancelar (null)", async (t) => {
    mockTransicion(t, async () => ({ rows: [] }));
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

function mockPagoConDesglose(t, { entregas = [{ id: 1, cantidad: 15000, moneda: "CUP" }], tasas = { tasa_usdt_cup: 100, tasa_usdt_usd: 1 }, fallaInsert = false } = {}) {
    const sqls = [];
    const client = {
        query: async (sql, params = []) => {
            sqls.push({ sql, params });
            if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
            if (/nextval/.test(sql)) return { rows: [{ n: 8 }] };
            if (/SELECT id, cantidad, moneda/.test(sql)) return { rows: entregas };
            if (/SELECT tasa_usdt_cup/.test(sql)) return { rows: [tasas] };
            if (/INSERT INTO entregas_pagos/.test(sql)) {
                if (fallaInsert) throw new Error("insert caído");
                return { rows: [{ id: 88, codigo: "P-008", cantidad_enviada: params[1], moneda_pago: params[2], frete_usdt: params[3], subtotal_usdt: params[4], total_usdt: params[5] }] };
            }
            if (/UPDATE entregas/.test(sql)) return { rows: entregas };
            return { rows: [] };
        },
        release: () => {}
    };
    t.mock.method(pool, "connect", async () => client);
    t.mock.method(pool, "query", async () => ({ rows: [] }));
    return sqls;
}

test("registrarPago nuevo: CUP + frete entero persiste subtotal, frete y total calculados por backend", async (t) => {
    const sqls = mockPagoConDesglose(t, { entregas: [{ id: 1, cantidad: 15000, moneda: "CUP" }], tasas: { tasa_usdt_cup: 100, tasa_usdt_usd: 1 } });
    const r = await registrarPago([1], { freteUsdt: 5, cantidadEnviada: 9999, monedaPago: "USD" });
    assert.equal(r.pago.subtotal_usdt, 150);
    assert.equal(r.pago.frete_usdt, 5);
    assert.equal(r.pago.total_usdt, 155);
    assert.equal(r.pago.cantidad_enviada, 155);
    assert.equal(r.pago.moneda_pago, "USDT");
    const insert = sqls.find(x => /INSERT INTO entregas_pagos/.test(x.sql));
    assert.deepEqual(insert.params.slice(3, 6), [5, 150, 155]);
});

test("registrarPago nuevo: USD y combinación CUP+USD usan sus tasas y solo filas elegibles", async (t) => {
    mockPagoConDesglose(t, {
        entregas: [{ id: 1, cantidad: 300, moneda: "USD" }, { id: 2, cantidad: 10000, moneda: "CUP" }],
        tasas: { tasa_usdt_cup: 100, tasa_usdt_usd: 2 }
    });
    const r = await registrarPago([1, 2, 99], { freteUsdt: 0.25 });
    assert.equal(r.pago.subtotal_usdt, 250);
    assert.equal(r.pago.total_usdt, 250.25);
    assert.equal(r.entregas.length, 2);
});

test("registrarPago nuevo: frete negativo, texto, NaN e infinito se rechazan sin actualizar entregas", async (t) => {
    for (const frete of [-1, "texto", "NaN", "Infinity"]) {
        const sqls = mockPagoConDesglose(t);
        assert.equal(await registrarPago([1], { freteUsdt: frete }), null, `frete inválido: ${frete}`);
        assert.equal(sqls.some(x => /UPDATE entregas/.test(x.sql)), false);
    }
});

test("registrarPago nuevo: fallo de persistencia hace rollback y no cambia estados", async (t) => {
    const sqls = mockPagoConDesglose(t, { fallaInsert: true });
    assert.equal(await registrarPago([1], { freteUsdt: 5 }), null);
    assert.equal(sqls.some(x => /UPDATE entregas/.test(x.sql)), false);
    assert.ok(sqls.some(x => x.sql === "ROLLBACK"));
});
