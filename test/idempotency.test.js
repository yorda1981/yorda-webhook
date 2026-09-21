"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — idempotencia por request-id (src/services/idempotency.js)
//
// Mockea pool.query (nunca toca Postgres real) con una "tabla" en memoria
// para simular fielmente el comportamiento de INSERT ... ON CONFLICT DO
// NOTHING ... RETURNING.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const idempotencia = require("../src/services/idempotency");

function mockTablaIdempotencia(t) {
    const tabla = new Map(); // key -> { resource_id }
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^INSERT INTO idempotency_keys/.test(sql)) {
            const [key] = params;
            if (tabla.has(key)) return { rows: [] }; // ON CONFLICT DO NOTHING
            tabla.set(key, { resource_id: null });
            return { rows: [{ key }] };
        }
        if (/^SELECT resource_id FROM idempotency_keys/.test(sql)) {
            const [key] = params;
            const fila = tabla.get(key);
            return { rows: fila ? [{ resource_id: fila.resource_id }] : [] };
        }
        if (/^UPDATE idempotency_keys/.test(sql)) {
            const [resourceId, key] = params;
            if (tabla.has(key)) tabla.get(key).resource_id = resourceId;
            return { rows: [] };
        }
        if (/^DELETE FROM idempotency_keys/.test(sql)) {
            const [key] = params;
            const fila = tabla.get(key);
            if (fila && fila.resource_id === null) tabla.delete(key);
            return { rows: [] };
        }
        return { rows: [] };
    });
    return tabla;
}

test("reclamar: clave nueva -> nueva:true", async (t) => {
    mockTablaIdempotencia(t);
    const r = await idempotencia.reclamar("k1", "test");
    assert.equal(r.nueva, true);
});

test("reclamar: sin clave (undefined/null) -> siempre nueva:true, no toca la DB", async (t) => {
    let llamadas = 0;
    t.mock.method(pool, "query", async () => { llamadas++; return { rows: [] }; });
    assert.deepEqual(await idempotencia.reclamar(null, "test"), { nueva: true });
    assert.deepEqual(await idempotencia.reclamar(undefined, "test"), { nueva: true });
    assert.equal(llamadas, 0);
});

test("reclamar: misma clave dos veces -> la segunda es nueva:false", async (t) => {
    mockTablaIdempotencia(t);
    const r1 = await idempotencia.reclamar("k2", "test");
    const r2 = await idempotencia.reclamar("k2", "test");
    assert.equal(r1.nueva, true);
    assert.equal(r2.nueva, false);
});

test("reclamar: si la clave ya fue resuelta, la segunda llamada devuelve el resourceId", async (t) => {
    mockTablaIdempotencia(t);
    await idempotencia.reclamar("k3", "test");
    await idempotencia.resolver("k3", 42);
    const r2 = await idempotencia.reclamar("k3", "test");
    assert.equal(r2.nueva, false);
    assert.equal(r2.resourceId, 42);
});

test("reclamar: si la clave está reclamada pero AÚN no resuelta (carrera) -> resourceId null", async (t) => {
    mockTablaIdempotencia(t);
    await idempotencia.reclamar("k4", "test");
    // Nunca se llama a resolver() -- simula que la primera creación sigue en curso.
    const r2 = await idempotencia.reclamar("k4", "test");
    assert.equal(r2.nueva, false);
    assert.equal(r2.resourceId, null);
});

test("claves distintas nunca chocan entre sí", async (t) => {
    mockTablaIdempotencia(t);
    const rA = await idempotencia.reclamar("k-a", "test");
    const rB = await idempotencia.reclamar("k-b", "test");
    assert.equal(rA.nueva, true);
    assert.equal(rB.nueva, true);
});

test("liberar: una clave sin resolver se puede reclamar de nuevo después de liberarla", async (t) => {
    mockTablaIdempotencia(t);
    await idempotencia.reclamar("k5", "test");
    await idempotencia.liberar("k5");
    const r2 = await idempotencia.reclamar("k5", "test");
    assert.equal(r2.nueva, true, "tras liberar, la clave debe poder reclamarse como si fuera nueva");
});

test("liberar: una clave YA resuelta (con resource_id) no se borra -- nunca se libera un recurso ya creado", async (t) => {
    const tabla = mockTablaIdempotencia(t);
    await idempotencia.reclamar("k6", "test");
    await idempotencia.resolver("k6", 99);
    await idempotencia.liberar("k6"); // liberar() solo borra si resource_id IS NULL
    assert.equal(tabla.has("k6"), true);
    assert.equal(tabla.get("k6").resource_id, 99);
});

test("reclamar: error de DB (tabla no migrada) -> degrada a nueva:true, nunca revienta ni bloquea", async (t) => {
    t.mock.method(pool, "query", async () => { throw new Error('relation "idempotency_keys" does not exist'); });
    const r = await idempotencia.reclamar("k7", "test");
    assert.equal(r.nueva, true);
});

test("resolver: error de DB no revienta", async (t) => {
    t.mock.method(pool, "query", async () => { throw new Error("DB caída"); });
    await assert.doesNotReject(() => idempotencia.resolver("k8", 1));
});

test("liberar: error de DB no revienta", async (t) => {
    t.mock.method(pool, "query", async () => { throw new Error("DB caída"); });
    await assert.doesNotReject(() => idempotencia.liberar("k9"));
});
