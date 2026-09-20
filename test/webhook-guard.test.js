"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — deduplicación de mensajes y pausa humana
// (src/services/webhook-guard.js)
//
// Mockea pool.query (nunca toca Postgres real) y usa temporizadores falsos
// de node:test para probar la ventana de deduplicación sin esperar 5
// minutos de verdad.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const { yaFueProcesado, activarPausaHumana, enPausaHumana, _internos } = require("../src/services/webhook-guard");

// ── yaFueProcesado — deduplicación de messageId (reintentos de Z-API) ──

test("mensaje nuevo -> false (no estaba procesado)", () => {
    assert.equal(yaFueProcesado("msg-nuevo-1"), false);
});

test("mismo messageId dos veces seguidas -> la segunda es true (reintento del proveedor)", () => {
    const id = "msg-retry-1";
    assert.equal(yaFueProcesado(id), false); // primera vez: se procesa
    assert.equal(yaFueProcesado(id), true);  // reintento: se descarta
});

test("sin messageId (undefined/null) -> siempre false, nunca bloquea el flujo", () => {
    assert.equal(yaFueProcesado(undefined), false);
    assert.equal(yaFueProcesado(null), false);
    assert.equal(yaFueProcesado(""), false);
});

test("messageId distintos no se pisan entre sí", () => {
    assert.equal(yaFueProcesado("msg-a"), false);
    assert.equal(yaFueProcesado("msg-b"), false);
    assert.equal(yaFueProcesado("msg-a"), true);
    assert.equal(yaFueProcesado("msg-b"), true);
});

test("pasada la ventana de 5 minutos, el mismo messageId ya no se considera duplicado", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const id = "msg-expira";
    assert.equal(yaFueProcesado(id), false);
    assert.equal(yaFueProcesado(id), true); // todavía dentro de la ventana
    t.mock.timers.tick(5 * 60 * 1000 + 1);
    assert.equal(yaFueProcesado(id), false); // expiró -> se trata como nuevo otra vez
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
