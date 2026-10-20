"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const funnel = require("../src/services/commercial-funnel");

function fakeDb({ customerExists = true } = {}) {
    const calls = [];
    const client = {
        async query(sql, params = []) {
            calls.push({ sql: String(sql), params });
            if (/SELECT 1 FROM customers/.test(sql)) return { rows: customerExists ? [{ "?column?": 1 }] : [] };
            if (/UPDATE customers SET current_quote_id/.test(sql)) return { rows: [] };
            if (/UPDATE commercial_funnel_quotes/.test(sql)) return { rows: [{ quote_id: params[0] }] };
            return { rows: [] };
        },
        release() { calls.push({ sql: "RELEASE" }); }
    };
    return { calls, db: { connect: async () => client, query: client.query } };
}

test("crear cotización persiste una identidad única y actualiza la cotización vigente en una transacción", async () => {
    const { calls, db } = fakeDb();
    const id = await funnel.crearCotizacion({ phone: "5511999999999", tipo: "brl_cup", monto: 500, salida: 90000 }, db);
    assert.match(id, /^[0-9a-f-]{36}$/i);
    assert.equal(calls[0].sql, "BEGIN");
    assert.match(calls.find(c => /INSERT INTO commercial_funnel_quotes/.test(c.sql)).sql, /quote_id,phone,quote_type,amount,output_amount/);
    assert.deepEqual(calls.find(c => /UPDATE customers SET current_quote_id/.test(c.sql)).params, ["5511999999999", id]);
    assert.equal(calls.at(-2).sql, "COMMIT");
    assert.equal(calls.at(-1).sql, "RELEASE");
});

test("si no existe el cliente, no deja un evento huérfano ni altera el flujo financiero", async () => {
    const { calls, db } = fakeDb({ customerExists: false });
    assert.equal(await funnel.crearCotizacion({ phone: "5511999999999", tipo: "brl_cup", monto: 100 }, db), null);
    assert.equal(calls.some(c => /INSERT INTO commercial_funnel_quotes/.test(c.sql)), false);
    assert.equal(calls.some(c => c.sql === "ROLLBACK"), true);
});

test("un PIX solo cuenta como aceptado cuando todos los envíos al proveedor devolvieron aceptación HTTP", async () => {
    const accepted = await funnel.registrarPixProveedor("5511999999999", [true, true, true], { query: async () => ({ rows: [{ quote_id: "q1" }] }) });
    const partial = await funnel.registrarPixProveedor("5511999999999", [true, false], { query: async () => ({ rows: [{ quote_id: "q1" }] }) });
    const unknown = await funnel.registrarPixProveedor("5511999999999", [false, false], { query: async () => ({ rows: [] }) });
    assert.equal(accepted.providerStatus, "ACCEPTED");
    assert.equal(partial.providerStatus, "PARTIAL");
    assert.equal(unknown.providerStatus, "UNKNOWN");
});

test("los hitos idempotentes no reemplazan timestamps previos y solo admiten estados conocidos", async () => {
    const queries = [];
    const client = { query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: /SELECT q\.quote_id/.test(sql) ? [{ quote_id: "q1" }] : [{ quote_id: "q1" }] };
    }, release() {} };
    const db = { connect: async () => client, query: client.query };
    await funnel.registrarComprobante("5511999999999", db);
    await funnel.iniciarEnvioPix("5511999999999", db);
    assert.match(queries.find(q => /receipt_received_at=COALESCE/.test(q.sql)).sql, /receipt_received_at=COALESCE\(receipt_received_at,NOW\(\)\)/);
    assert.match(queries.find(q => /pix_requested_at=COALESCE/.test(q.sql)).sql, /pix_provider_last_status='UNKNOWN'/);
});

test("un comprobante con varias cotizaciones PIX abiertas no se atribuye por adivinanza", async () => {
    const queries = [];
    const client = { query: async sql => {
        queries.push(String(sql));
        return { rows: /SELECT q\.quote_id/.test(sql) ? [{ quote_id: "q1" }, { quote_id: "q2" }] : [] };
    }, release() {} };
    assert.equal(await funnel.registrarComprobante("5511999999999", { connect: async () => client }), null);
    assert.equal(queries.some(sql => /SET current_quote_id=NULL/.test(sql)), true);
    assert.equal(queries.some(sql => /SET receipt_received_at/.test(sql)), false);
});

test("resumen mide cohortes por cotización y distingue avance observable de abandono", async () => {
    let sql = "";
    await funnel.obtenerResumen(30, { query: async q => { sql = q; return { rows: [{}] }; } });
    assert.match(sql, /FROM commercial_funnel_quotes q LEFT JOIN operations o ON o\.quote_id=q\.quote_id[\s\S]*WHERE q\.created_at >= NOW\(\)-\(\$1::int \* INTERVAL '1 day'\)/);
    assert.match(sql, /pix_provider_accepted_at IS NOT NULL/);
    assert.match(sql, /COUNT\(o\.id\) FILTER \(WHERE o\.status='cancelada' OR o\.cancelada_at IS NOT NULL\)/);
    assert.match(sql, /sin_avance_observable_24h/);
    assert.doesNotMatch(sql, /conversion|UPDATE|DELETE/i);
});

test("los flujos conectan cotización, aceptación, comprobante y operación sin generar mensajes nuevos", () => {
    const read = rel => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    const quote = read("src/flows/cotizacion-flow.js");
    const pix = read("src/flows/pix-flow.js");
    const ops = read("src/services/operations.js");
    assert.equal((quote.match(/commercialFunnel\.crearCotizacion\(/g) || []).length, 4);
    assert.match(pix, /commercialFunnel\.marcarAceptacion\(phone\)/);
    assert.match(pix, /commercialFunnel\.registrarPixProveedor\(phone, credentialAccepted \? providerResults : \[\.\.\.providerResults, false\]\)/);
    assert.match(pix, /commercialFunnel\.registrarComprobante\(phone\)/);
    assert.match(pix, /quoteId:\s+cliente\.current_quote_id/);
    assert.match(ops, /comprobante_datos, quote_id/);
    assert.match(ops, /data\.quoteId \|\| null/);
    assert.match(ops, /confirmed_at = NOW\(\)/);
    assert.match(ops, /completed_at = NOW\(\)/);
    assert.match(ops, /cancelada_at = NOW\(\)/);
    const index = read("index.js");
    assert.match(index, /if \(await yaFueProcesado\(messageId\)\) return/);
});

test("la migración no reescribe ni elimina historial previo", () => {
    const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "0043_commercial_quote_funnel.sql"), "utf8");
    assert.match(sql, /CREATE TABLE IF NOT EXISTS commercial_funnel_quotes/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS current_quote_id UUID/);
    assert.doesNotMatch(sql, /\bUPDATE\b|\bDELETE\b|DROP TABLE|DROP COLUMN/i);
});
