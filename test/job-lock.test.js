"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — job-lock (src/services/job-lock.js)
//
// Mockea pool.connect()/client.query (nunca toca Postgres real). Objetivo:
// si dos instancias llamaran conLockExclusivo para el mismo job al mismo
// tiempo, solo una debe ejecutar fn() — la otra se salta sin error.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const { conLockExclusivo, LOCK_IDS } = require("../src/services/job-lock");

function fakeClient(secuenciaTomado) {
    let i = 0;
    const queries = [];
    return {
        client: {
            query: async (sql, params) => {
                queries.push(sql);
                if (/pg_try_advisory_lock/.test(sql)) {
                    const tomado = secuenciaTomado[i++] ?? secuenciaTomado[secuenciaTomado.length - 1];
                    return { rows: [{ tomado }] };
                }
                if (/pg_advisory_unlock/.test(sql)) return { rows: [{}] };
                return { rows: [] };
            },
            release: () => {}
        },
        queries
    };
}

test("job desconocido -> revienta con un error claro (evita el typo silencioso)", async () => {
    await assert.rejects(() => conLockExclusivo("jobQueNoExiste", () => {}), /no está registrado/);
});

test("lock disponible -> ejecuta fn() y libera el lock al terminar", async (t) => {
    const { client, queries } = fakeClient([true]);
    t.mock.method(pool, "connect", async () => client);
    let seEjecuto = false;
    const resultado = await conLockExclusivo("crmRecordatorios", () => { seEjecuto = true; });
    assert.equal(resultado, true);
    assert.equal(seEjecuto, true);
    assert.ok(queries.some((q) => /pg_advisory_unlock/.test(q)), "debe liberar el lock");
});

test("lock ya tomado por otra instancia -> se salta, no ejecuta fn(), no revienta", async (t) => {
    const { client } = fakeClient([false]);
    t.mock.method(pool, "connect", async () => client);
    let seEjecuto = false;
    const resultado = await conLockExclusivo("crmRecordatorios", () => { seEjecuto = true; });
    assert.equal(resultado, false);
    assert.equal(seEjecuto, false);
});

test("dos llamadas simultáneas (misma instancia) al mismo job -> solo la primera corre", async (t) => {
    // Simula lo que vería Postgres real: la primera consigue el lock, la
    // segunda (mismo instante) lo ve tomado.
    const { client } = fakeClient([true, false]);
    t.mock.method(pool, "connect", async () => client);
    let corridas = 0;
    const [r1, r2] = await Promise.all([
        conLockExclusivo("vipRecalculo", async () => { corridas++; }),
        conLockExclusivo("vipRecalculo", async () => { corridas++; })
    ]);
    assert.equal(corridas, 1);
    assert.equal([r1, r2].filter(Boolean).length, 1);
});

test("fn() revienta -> igual libera el lock (no lo deja trabado para la próxima corrida)", async (t) => {
    const { client, queries } = fakeClient([true]);
    t.mock.method(pool, "connect", async () => client);
    const resultado = await conLockExclusivo("tasasDiarias", () => { throw new Error("boom"); });
    assert.equal(resultado, false); // se reporta como no-ejecutado-con-éxito, pero no revienta el caller
    assert.ok(queries.some((q) => /pg_advisory_unlock/.test(q)), "debe liberar el lock incluso si fn() falla");
});

test("no se puede conectar a la DB -> se salta esta corrida, nunca revienta", async (t) => {
    t.mock.method(pool, "connect", async () => { throw new Error("DB caída"); });
    let seEjecuto = false;
    const resultado = await conLockExclusivo("saludosMatutinos", () => { seEjecuto = true; });
    assert.equal(resultado, false);
    assert.equal(seEjecuto, false);
});

test("LOCK_IDS: todos los jobs conocidos tienen un id numérico único", () => {
    const ids = Object.values(LOCK_IDS);
    assert.equal(new Set(ids).size, ids.length, "no debe haber ids repetidos entre jobs");
    for (const id of ids) assert.equal(typeof id, "number");
});
