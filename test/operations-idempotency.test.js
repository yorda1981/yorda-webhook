"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — idempotencia de operaciones (src/services/operations.js)
//
// Mockea pool.query (nunca toca Postgres real). El objetivo es asegurar
// que una operación ya confirmada/completada no se vuelva a confirmar ni
// completar si el endpoint se llama dos veces (doble clic en el
// dashboard, reintento de red) — eso evita renotificar dos veces al
// cliente por WhatsApp (ver index.js: solo notifica si la función
// devuelve una fila).
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const {
    agregarOperacion,
    confirmarOperacion,
    completarOperacion,
    existeOperacionPendiente,
    buscarPorRefWeb,
    obtenerEstadisticas,
    obtenerTodas
} = require("../src/services/operations");

test("confirmarOperacion: usa el guard WHERE status='pendiente' en el UPDATE", async (t) => {
    let sqlUsado = "";
    t.mock.method(pool, "query", async (sql) => { sqlUsado = sql; return { rows: [{ id: 1, status: "confirmada" }] }; });
    await confirmarOperacion(1);
    assert.match(sqlUsado, /status\s*=\s*'pendiente'/);
});

test("confirmarOperacion: primera llamada (estaba pendiente) -> devuelve la fila actualizada", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [{ id: 5, status: "confirmada", phone: "5511900000000" }] }));
    const r = await confirmarOperacion(5);
    assert.equal(r.status, "confirmada");
});

test("confirmarOperacion: segunda llamada sobre la misma operación (ya confirmada) -> false, no reenvía notificación", async (t) => {
    // Simula lo que haría Postgres real: el WHERE status='pendiente' ya no
    // encuentra la fila porque el primer confirmarOperacion() ya la movió.
    t.mock.method(pool, "query", async () => ({ rows: [] }));
    const r = await confirmarOperacion(5);
    assert.equal(r, false);
});

test("confirmarOperacion: operación inexistente -> false", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [] }));
    assert.equal(await confirmarOperacion(999999), false);
});

test("confirmarOperacion: error de DB -> false, nunca revienta", async (t) => {
    t.mock.method(pool, "query", async () => { throw new Error("DB caída"); });
    assert.equal(await confirmarOperacion(1), false);
});

test("completarOperacion: usa el guard WHERE status='confirmada' en el UPDATE", async (t) => {
    let sqlUsado = "";
    t.mock.method(pool, "query", async (sql) => { sqlUsado = sql; return { rows: [{ id: 1, status: "completada" }] }; });
    await completarOperacion(1);
    assert.match(sqlUsado, /status\s*=\s*'confirmada'/);
});

test("completarOperacion: primera llamada (estaba confirmada) -> devuelve la fila", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [{ id: 5, status: "completada" }] }));
    const r = await completarOperacion(5);
    assert.equal(r.status, "completada");
});

test("completarOperacion: doble completado -> null la segunda vez, no reenvía notificación ni recalcula VIP dos veces", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [] }));
    assert.equal(await completarOperacion(5), null);
});

test("completarOperacion: intentar completar una operación todavía 'pendiente' (nunca confirmada) -> null", async (t) => {
    // El guard exige status='confirmada'; una pendiente no matchea -> 0 filas.
    t.mock.method(pool, "query", async () => ({ rows: [] }));
    assert.equal(await completarOperacion(7), null);
});

test("completarOperacion: error de DB -> null, nunca revienta", async (t) => {
    t.mock.method(pool, "query", async () => { throw new Error("DB caída"); });
    assert.equal(await completarOperacion(1), null);
});

// ── Detección de operación duplicada (mismo cliente, mismo monto, todavía pendiente) ──

test("existeOperacionPendiente: hay una fila -> true", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [{ id: 1 }] }));
    assert.equal(await existeOperacionPendiente("5511900000000", 100), true);
});

test("existeOperacionPendiente: no hay filas -> false", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [] }));
    assert.equal(await existeOperacionPendiente("5511900000000", 100), false);
});

test("existeOperacionPendiente: error de DB -> false (no bloquea al cliente por un error nuestro)", async (t) => {
    t.mock.method(pool, "query", async () => { throw new Error("DB caída"); });
    assert.equal(await existeOperacionPendiente("5511900000000", 100), false);
});

// ── Deduplicación de pedidos de la calculadora web (ref_web) ──

test("buscarPorRefWeb: ref ya existe -> devuelve la operación existente (no se crea otra)", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [{ id: 42, ref_web: "WEB-123" }] }));
    const r = await buscarPorRefWeb("WEB-123");
    assert.equal(r.id, 42);
});

test("buscarPorRefWeb: ref nuevo -> null", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [] }));
    assert.equal(await buscarPorRefWeb("WEB-NUEVO"), null);
});

test("buscarPorRefWeb: sin ref -> null, no consulta la DB", async (t) => {
    let llamadas = 0;
    t.mock.method(pool, "query", async () => { llamadas++; return { rows: [] }; });
    assert.equal(await buscarPorRefWeb(null), null);
    assert.equal(llamadas, 0);
});

// ── agregarOperacion: siempre nace 'pendiente' ──

test("agregarOperacion: siempre inserta con status='pendiente' (nunca confirmada/completada de entrada)", async (t) => {
    let sqlUsado = "";
    t.mock.method(pool, "query", async (sql) => { sqlUsado = sql; return { rows: [{ id: 1, status: "pendiente" }] }; });
    await agregarOperacion({ phone: "5511900000000", monto: 100 });
    assert.match(sqlUsado, /'pendiente'/);
});

test("agregarOperacion: error de DB -> null, nunca revienta", async (t) => {
    t.mock.method(pool, "query", async () => { throw new Error("DB caída"); });
    assert.equal(await agregarOperacion({ phone: "5511900000000", monto: 100 }), null);
});

// ── obtenerEstadisticas: el "Resumen General" del dashboard sigue siendo
// global a propósito (incluye Transferencias, Entregas y Recargas) -- ver
// public/dashboard.html ("📊 Resumen General" + "Incluye Transferencias,
// Entregas y Recargas"). Este test es una guarda de regresión: si alguna vez
// se le agrega un filtro por tipo aquí, debe ser una decisión explícita, no
// un efecto colateral de otro cambio.

test("obtenerEstadisticas: agrega TODA la tabla operations, sin filtrar por tipo (Resumen General es global a propósito)", async (t) => {
    let sqlUsado = "";
    t.mock.method(pool, "query", async (sql) => {
        sqlUsado = sql;
        return { rows: [{ total: 5, volumen: 745, pendientes: 2, completadas: 1 }] };
    });
    const stats = await obtenerEstadisticas();
    assert.doesNotMatch(sqlUsado, /WHERE.*tipo/is, "no debe filtrar por tipo -- Recargas debe seguir contando en el Resumen General");
    assert.equal(stats.totalOperaciones, 5);
    assert.equal(stats.volumenTotal, 745);
});

// ── obtenerTodas: expone entrega_cantidad/entrega_moneda (cantidad REAL a
// entregar, ver public/dashboard.html "A ENTREGAR") sin recalcular nada --
// solo un LEFT JOIN de solo lectura a la tabla entregas ya existente.
// operations.cup se guarda en 0 para usd_efectivo (pedido-web-flow.js), así
// que no es confiable como "cantidad a entregar" -- entregas.cantidad sí lo
// es siempre, para ambas monedas.

test("obtenerTodas: hace LEFT JOIN a entregas (1:1 por operation_id), sin recalcular tasas ni montos", async (t) => {
    let sqlUsado = "";
    t.mock.method(pool, "query", async (sql) => { sqlUsado = sql; return { rows: [] }; });
    await obtenerTodas();
    assert.match(sqlUsado, /LEFT JOIN entregas/i);
    assert.match(sqlUsado, /e\.cantidad AS entrega_cantidad/i);
    assert.match(sqlUsado, /e\.moneda AS entrega_moneda/i);
    assert.doesNotMatch(sqlUsado, /\*.*tasa|ROUND|::numeric/i, "no debe recalcular ningún valor, solo exponer lo ya almacenado");
});

test("obtenerTodas: sigue devolviendo TODAS las columnas de operations (o.*), no reemplaza nada existente", async (t) => {
    let sqlUsado = "";
    t.mock.method(pool, "query", async (sql) => { sqlUsado = sql; return { rows: [] }; });
    await obtenerTodas();
    assert.match(sqlUsado, /SELECT o\.\*/);
});
