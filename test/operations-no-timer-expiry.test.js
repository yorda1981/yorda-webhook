"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const { expirarOperacionesPendientes } = require("../src/services/operations");

test("el TTL nunca cambia ni expira operaciones financieras reales", async (t) => {
    const consultas = [];
    t.mock.method(pool, "query", async (sql, params) => {
        consultas.push({ sql, params });
        return { rows: [] };
    });
    assert.deepEqual(await expirarOperacionesPendientes(), []);
    assert.deepEqual(consultas, [], "no ejecuta UPDATE ni cambia estados de operations por tiempo");
});
