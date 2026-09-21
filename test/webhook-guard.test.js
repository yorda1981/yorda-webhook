"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — deduplicación de mensajes y pausa humana
// (src/services/webhook-guard.js)
//
// Mockea pool.query (nunca toca Postgres real) y usa temporizadores falsos
// de node:test para probar la ventana de deduplicación sin esperar 5
// minutos de verdad.
//
// Fase 6: yaFueProcesado ahora es async (INSERT ... ON CONFLICT contra
// webhook_events es la fuente de verdad; el Set en memoria es solo el
// filtro rápido de primera línea). "insertado" simula un messageId nuevo
// (RETURNING trae la fila); "0 filas" simula que ya existía — en Postgres
// real, esto pasa tanto si ESTE proceso ya lo vio como si lo vio OTRA
// instancia.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const { yaFueProcesado, activarPausaHumana, enPausaHumana, _internos } = require("../src/services/webhook-guard");

function mockInsertNuevo(t) {
    return t.mock.method(pool, "query", async (sql) => {
        if (/INSERT INTO webhook_events/.test(sql)) return { rows: [{ message_id: "x" }] };
        return { rows: [] };
    });
}
function mockInsertDuplicado(t) {
    return t.mock.method(pool, "query", async (sql) => {
        if (/INSERT INTO webhook_events/.test(sql)) return { rows: [] };
        return { rows: [] };
    });
}

// ── yaFueProcesado — deduplicación de messageId (reintentos de Z-API) ──

test("mensaje nuevo -> false (no estaba procesado)", async (t) => {
    mockInsertNuevo(t);
    assert.equal(await yaFueProcesado("msg-nuevo-1"), false);
});

test("mismo messageId dos veces seguidas -> la segunda es true, sin llegar a tocar la DB (filtro en memoria)", async (t) => {
    const id = "msg-retry-1";
    let llamadasDB = 0;
    t.mock.method(pool, "query", async () => { llamadasDB++; return { rows: [{ message_id: "x" }] }; });
    assert.equal(await yaFueProcesado(id), false); // primera vez: se procesa, sí toca la DB
    assert.equal(await yaFueProcesado(id), true);  // reintento: lo corta el Set en memoria, sin otra query
    assert.equal(llamadasDB, 1);
});

test("sin messageId (undefined/null) -> siempre false, nunca toca la DB", async (t) => {
    let llamadasDB = 0;
    t.mock.method(pool, "query", async () => { llamadasDB++; return { rows: [] }; });
    assert.equal(await yaFueProcesado(undefined), false);
    assert.equal(await yaFueProcesado(null), false);
    assert.equal(await yaFueProcesado(""), false);
    assert.equal(llamadasDB, 0);
});

test("messageId distintos no se pisan entre sí", async (t) => {
    mockInsertNuevo(t);
    assert.equal(await yaFueProcesado("msg-a"), false);
    assert.equal(await yaFueProcesado("msg-b"), false);
    assert.equal(await yaFueProcesado("msg-a"), true); // memoria
    assert.equal(await yaFueProcesado("msg-b"), true); // memoria
});

test("messageId ya visto por OTRA instancia (no está en la memoria de este proceso, pero sí en Postgres) -> true", async (t) => {
    mockInsertDuplicado(t); // ON CONFLICT DO NOTHING -> 0 filas
    assert.equal(await yaFueProcesado("msg-de-otra-instancia"), true);
});

test("si Postgres falla (tabla no migrada, conexión caída) -> false, nunca bloquea el webhook", async (t) => {
    t.mock.method(pool, "query", async () => { throw new Error("relation \"webhook_events\" does not exist"); });
    assert.equal(await yaFueProcesado("msg-sin-tabla"), false);
});

test("pasada la ventana de 5 minutos, el mismo messageId vuelve a consultar la DB", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    mockInsertNuevo(t);
    const id = "msg-expira";
    assert.equal(await yaFueProcesado(id), false);
    assert.equal(await yaFueProcesado(id), true); // todavía dentro de la ventana (memoria)
    t.mock.timers.tick(5 * 60 * 1000 + 1);
    assert.equal(await yaFueProcesado(id), false); // expiró en memoria -> vuelve a preguntarle a Postgres (mock: sigue "nuevo")
    t.mock.timers.reset();
});

// ── activarPausaHumana / enPausaHumana ──

test("activarPausaHumana: teléfono que no empieza en 55 -> no toca la DB", async (t) => {
    let llamadas = 0;
    t.mock.method(pool, "query", async () => { llamadas++; return { rows: [] }; });
    await activarPausaHumana("5352223344"); // número cubano, no brasileño
    assert.equal(llamadas, 0);
});

test("activarPausaHumana: sin teléfono -> no toca la DB", async (t) => {
    let llamadas = 0;
    t.mock.method(pool, "query", async () => { llamadas++; return { rows: [] }; });
    await activarPausaHumana(null);
    assert.equal(llamadas, 0);
});

test("activarPausaHumana: teléfono brasileño válido -> hace UPSERT en customers", async (t) => {
    _internos.ULTIMA_PAUSA_CACHE.clear();
    const llamadas = [];
    t.mock.method(pool, "query", async (sql, params) => { llamadas.push({ sql, params }); return { rows: [] }; });
    await activarPausaHumana("5511988887777");
    assert.equal(llamadas.length, 1);
    assert.match(llamadas[0].sql, /INSERT INTO customers/);
    assert.match(llamadas[0].sql, /ON CONFLICT \(phone\) DO UPDATE/);
    assert.equal(llamadas[0].params[0], "5511988887777");
});

test("activarPausaHumana: dos llamadas seguidas al mismo número -> la segunda NO vuelve a tocar la DB (debounce 60s)", async (t) => {
    _internos.ULTIMA_PAUSA_CACHE.clear();
    let llamadas = 0;
    t.mock.method(pool, "query", async () => { llamadas++; return { rows: [] }; });
    await activarPausaHumana("5511977776666");
    await activarPausaHumana("5511977776666");
    assert.equal(llamadas, 1);
});

test("activarPausaHumana: si pool.query falla, no revienta (deja pasar al bot)", async (t) => {
    t.mock.method(pool, "query", async () => { throw new Error("DB caída"); });
    _internos.ULTIMA_PAUSA_CACHE.clear();
    await assert.doesNotReject(() => activarPausaHumana("5511900000000"));
});

test("enPausaHumana: sin pausa_hasta en la fila -> false", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [{ pausa_hasta: null }] }));
    assert.equal(await enPausaHumana("5511988887777"), false);
});

test("enPausaHumana: pausa_hasta en el futuro -> true (bot silenciado)", async (t) => {
    const futuro = new Date(Date.now() + 5 * 60 * 1000);
    t.mock.method(pool, "query", async () => ({ rows: [{ pausa_hasta: futuro }] }));
    assert.equal(await enPausaHumana("5511988887777"), true);
});

test("enPausaHumana: pausa_hasta en el pasado -> false (ya se puede volver a hablar con el bot)", async (t) => {
    const pasado = new Date(Date.now() - 5 * 60 * 1000);
    t.mock.method(pool, "query", async () => ({ rows: [{ pausa_hasta: pasado }] }));
    assert.equal(await enPausaHumana("5511988887777"), false);
});

test("enPausaHumana: cliente inexistente (sin filas) -> false", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [] }));
    assert.equal(await enPausaHumana("5511900000000"), false);
});

test("enPausaHumana: si pool.query falla -> false (ante la duda, deja pasar al bot; nunca lo silencia por error)", async (t) => {
    t.mock.method(pool, "query", async () => { throw new Error("DB caída"); });
    assert.equal(await enPausaHumana("5511900000000"), false);
});

test("enPausaHumana: sin teléfono -> false, no toca la DB", async (t) => {
    let llamadas = 0;
    t.mock.method(pool, "query", async () => { llamadas++; return { rows: [] }; });
    assert.equal(await enPausaHumana(null), false);
    assert.equal(llamadas, 0);
});
