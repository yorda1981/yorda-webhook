"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — identidad de comprobantes PIX
// (src/services/comprobante-identidad.js)
//
// Normalización pura (sin DB) + búsqueda de duplicado por identidad
// fuerte (E2E / ID de transacción) con pool.query mockeado.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const {
    normalizarE2E, normalizarTransaccionId, calcularDestinatarioMatch,
    extraerIdentidadComprobante, buscarOperacionPorIdentidad
} = require("../src/services/comprobante-identidad");

// ── normalizarE2E ──

test("normalizarE2E: acepta un E2E bien formado (E + 32 alfanuméricos)", () => {
    const e2e = "E12345678202401011200ABCDEFGHIJK";
    assert.equal(normalizarE2E(e2e), e2e);
});

test("normalizarE2E: quita espacios y pasa a mayúsculas antes de validar", () => {
    const e2e = "e12345678 202401011200abcdefghijk";
    assert.equal(normalizarE2E(e2e), "E12345678202401011200ABCDEFGHIJK");
});

test("normalizarE2E: texto que no tiene forma de E2E -> null (nunca inventa)", () => {
    assert.equal(normalizarE2E("comprobante123"), null);
    assert.equal(normalizarE2E("E123"), null); // demasiado corto
    assert.equal(normalizarE2E(""), null);
    assert.equal(normalizarE2E(null), null);
    assert.equal(normalizarE2E(undefined), null);
});

// ── normalizarTransaccionId ──

test("normalizarTransaccionId: acepta un ID razonable, recorta espacios", () => {
    assert.equal(normalizarTransaccionId("  ABC123456  "), "ABC123456");
});

test("normalizarTransaccionId: demasiado corto -> null (evita falsos duplicados)", () => {
    assert.equal(normalizarTransaccionId("123"), null);
    assert.equal(normalizarTransaccionId(""), null);
    assert.equal(normalizarTransaccionId(null), null);
});

// ── calcularDestinatarioMatch ──

test("calcularDestinatarioMatch: destino_correcto=true -> 'coincide'", () => {
    assert.equal(calcularDestinatarioMatch({ destino_correcto: true }), "coincide");
});

test("calcularDestinatarioMatch: destino_correcto=false -> 'diferente'", () => {
    assert.equal(calcularDestinatarioMatch({ destino_correcto: false }), "diferente");
});

test("calcularDestinatarioMatch: sin destino_correcto (ilegible) -> 'desconocido', nunca asume", () => {
    assert.equal(calcularDestinatarioMatch({}), "desconocido");
    assert.equal(calcularDestinatarioMatch(null), "desconocido");
});

// ── extraerIdentidadComprobante (prioridad E2E > transacción > fallback) ──

test("extraerIdentidadComprobante: con E2E válido -> tipo 'e2e', prioridad máxima", () => {
    const datos = { e2e: "E12345678202401011200ABCDEFGHIJK", id_transaccion: "OTRO-ID-123" };
    const id = extraerIdentidadComprobante(datos);
    assert.equal(id.tipo, "e2e");
    assert.equal(id.columna, "comprobante_e2e");
    assert.equal(id.valor, "E12345678202401011200ABCDEFGHIJK");
});

test("extraerIdentidadComprobante: sin E2E pero con ID de transacción -> tipo 'transaccion_id'", () => {
    const id = extraerIdentidadComprobante({ id_transaccion: "TXN-987654" });
    assert.equal(id.tipo, "transaccion_id");
    assert.equal(id.columna, "comprobante_transaccion_id");
    assert.equal(id.valor, "TXN-987654");
});

test("extraerIdentidadComprobante: sin ninguno -> tipo 'fallback' (el caller usa monto+ventana)", () => {
    const id = extraerIdentidadComprobante({ valor: 300 });
    assert.equal(id.tipo, "fallback");
    assert.equal(id.columna, null);
});

// ── buscarOperacionPorIdentidad ──

function mockOperations(t, filas) {
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^SELECT \* FROM operations WHERE comprobante_e2e = \$1/.test(sql)) {
            const [valor] = params;
            const encontrada = filas.find(f => f.comprobante_e2e === valor && f.status !== "rechazada");
            return { rows: encontrada ? [encontrada] : [] };
        }
        if (/^SELECT \* FROM operations WHERE comprobante_transaccion_id = \$1/.test(sql)) {
            const [valor] = params;
            const encontrada = filas.find(f => f.comprobante_transaccion_id === valor && f.status !== "rechazada");
            return { rows: encontrada ? [encontrada] : [] };
        }
        return { rows: [] };
    });
}

test("buscarOperacionPorIdentidad: encuentra la operación con el mismo E2E", async (t) => {
    mockOperations(t, [{ id: 1, comprobante_e2e: "E111", status: "pendiente" }]);
    const r = await buscarOperacionPorIdentidad({ tipo: "e2e", columna: "comprobante_e2e", valor: "E111" });
    assert.equal(r.id, 1);
});

test("buscarOperacionPorIdentidad: E2E distinto -> no encuentra nada (dos pagos legítimos, no se confunden)", async (t) => {
    mockOperations(t, [{ id: 1, comprobante_e2e: "E111", status: "pendiente" }]);
    const r = await buscarOperacionPorIdentidad({ tipo: "e2e", columna: "comprobante_e2e", valor: "E222" });
    assert.equal(r, null);
});

test("buscarOperacionPorIdentidad: una operación 'rechazada' con el mismo E2E no cuenta como duplicado", async (t) => {
    mockOperations(t, [{ id: 1, comprobante_e2e: "E111", status: "rechazada" }]);
    const r = await buscarOperacionPorIdentidad({ tipo: "e2e", columna: "comprobante_e2e", valor: "E111" });
    assert.equal(r, null);
});

test("buscarOperacionPorIdentidad: tipo 'fallback' -> nunca consulta la DB, siempre null", async (t) => {
    let llamadas = 0;
    t.mock.method(pool, "query", async () => { llamadas++; return { rows: [] }; });
    const r = await buscarOperacionPorIdentidad({ tipo: "fallback", columna: null, valor: null });
    assert.equal(r, null);
    assert.equal(llamadas, 0);
});

test("buscarOperacionPorIdentidad: error de DB (columna no migrada) -> degrada a null, nunca revienta", async (t) => {
    t.mock.method(pool, "query", async () => { throw new Error('column "comprobante_e2e" does not exist'); });
    const r = await buscarOperacionPorIdentidad({ tipo: "e2e", columna: "comprobante_e2e", valor: "E111" });
    assert.equal(r, null);
});
