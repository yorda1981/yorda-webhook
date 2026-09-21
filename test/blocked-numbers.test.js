"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — Números bloqueados (src/services/blocked-numbers.js)
//
// Mockea pool.query con una "tabla" blocked_numbers en memoria. Cubre
// normalización de teléfono, bloquear/desbloquear/listar, estaBloqueado y
// el filtro filtrarNoBloqueados que usan los jobs proactivos (saludo
// matutino, recordatorios CRM, aviso de nivel VIP).
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const {
    normalizarTelefono, estaBloqueado, bloquear, desbloquear, listarBloqueados, filtrarNoBloqueados
} = require("../src/services/blocked-numbers");

function mockTablaBloqueados(t) {
    const tabla = new Map(); // phone -> { phone, motivo, created_at }
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^INSERT INTO blocked_numbers/.test(sql)) {
            const [phone, motivo] = params;
            if (tabla.has(phone)) return { rows: [] }; // ON CONFLICT DO NOTHING
            const fila = { phone, motivo: motivo || null, created_at: new Date().toISOString() };
            tabla.set(phone, fila);
            return { rows: [fila] };
        }
        if (/^SELECT 1 FROM blocked_numbers WHERE phone = \$1/.test(sql)) {
            const [phone] = params;
            return { rows: tabla.has(phone) ? [{ "?column?": 1 }] : [] };
        }
        if (/^SELECT \* FROM blocked_numbers WHERE phone = \$1/.test(sql)) {
            const [phone] = params;
            return { rows: tabla.has(phone) ? [tabla.get(phone)] : [] };
        }
        if (/^DELETE FROM blocked_numbers WHERE phone = \$1/.test(sql)) {
            const [phone] = params;
            const existia = tabla.has(phone);
            tabla.delete(phone);
            return { rows: existia ? [{ phone }] : [] };
        }
        if (/^SELECT \* FROM blocked_numbers ORDER BY/.test(sql)) {
            return { rows: [...tabla.values()] };
        }
        return { rows: [] };
    });
    return tabla;
}

test("normalizarTelefono: antepone 55 a un número de 10-11 dígitos sin código de país", () => {
    assert.equal(normalizarTelefono("11987654321"), "5511987654321");
    assert.equal(normalizarTelefono("1187654321"), "551187654321");
});

test("normalizarTelefono: ya tiene 55 -> se deja igual", () => {
    assert.equal(normalizarTelefono("5511987654321"), "5511987654321");
});

test("normalizarTelefono: quita '+', espacios y guiones antes de normalizar", () => {
    assert.equal(normalizarTelefono("+55 11 98765-4321"), "5511987654321");
});

test("normalizarTelefono: vacío/inválido -> string vacío", () => {
    assert.equal(normalizarTelefono(""), "");
    assert.equal(normalizarTelefono(null), "");
});

test("bloquear: número nuevo -> se guarda y estaBloqueado pasa a true", async (t) => {
    mockTablaBloqueados(t);
    const r = await bloquear("11987654321", "spam");
    assert.equal(r.yaExistia, false);
    assert.equal(await estaBloqueado("11987654321"), true);
});

test("bloquear: mismo número normalizado de dos formas distintas -> es el mismo bloqueo", async (t) => {
    mockTablaBloqueados(t);
    await bloquear("+55 11 98765-4321", "motivo A");
    const r2 = await bloquear("5511987654321", "motivo B (ignorado)");
    assert.equal(r2.yaExistia, true);
    assert.equal(r2.bloqueado.motivo, "motivo A", "no debe pisar el motivo original de un bloqueo ya existente");
});

test("estaBloqueado: número nunca bloqueado -> false", async (t) => {
    mockTablaBloqueados(t);
    assert.equal(await estaBloqueado("5511900000000"), false);
});

test("desbloquear: quita el número -> vuelve a responder con normalidad (estaBloqueado false)", async (t) => {
    mockTablaBloqueados(t);
    await bloquear("11987654321", "prueba");
    assert.equal(await estaBloqueado("11987654321"), true);
    const ok = await desbloquear("11987654321");
    assert.equal(ok, true);
    assert.equal(await estaBloqueado("11987654321"), false, "tras desbloquear, el número debe volver a comportarse con normalidad");
});

test("desbloquear: número que no estaba bloqueado -> false, no revienta", async (t) => {
    mockTablaBloqueados(t);
    assert.equal(await desbloquear("5511900000099"), false);
});

test("estaBloqueado: si blocked_numbers no existe todavía (migración 0010 sin correr) -> degrada a false, nunca revienta", async (t) => {
    t.mock.method(pool, "query", async () => { throw new Error('relation "blocked_numbers" does not exist'); });
    assert.equal(await estaBloqueado("5511900000000"), false);
});

test("filtrarNoBloqueados: descarta del listado los teléfonos bloqueados, deja el resto intacto", async (t) => {
    mockTablaBloqueados(t);
    await bloquear("5511900000001", "spam");
    const items = [
        { phone: "5511900000001", nombre: "Bloqueado" },
        { phone: "5511900000002", nombre: "Normal" }
    ];
    const resultado = await filtrarNoBloqueados(items);
    assert.equal(resultado.length, 1);
    assert.equal(resultado[0].phone, "5511900000002");
});

test("filtrarNoBloqueados: lista vacía o sin ningún bloqueado -> se devuelve igual", async (t) => {
    mockTablaBloqueados(t);
    const items = [{ phone: "5511900000003" }];
    const resultado = await filtrarNoBloqueados(items);
    assert.deepEqual(resultado, items);
});

test("listarBloqueados: devuelve todos los bloqueos guardados", async (t) => {
    mockTablaBloqueados(t);
    await bloquear("5511900000001", "a");
    await bloquear("5511900000002", "b");
    const lista = await listarBloqueados();
    assert.equal(lista.length, 2);
});
