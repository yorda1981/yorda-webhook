"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — seguridad del webhook (src/middleware/webhook-security.js)
//
// No levantan un servidor HTTP real: llaman directo a los middlewares
// con un req/res/next falsos. No tocan Postgres, Z-API ni OpenAI.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const { verificarSecretoWebhook, validarPayloadWebhook, compararSeguro } = require("../src/middleware/webhook-security");

function fakeRes() {
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

// ── verificarSecretoWebhook ──

test("sin WEBHOOK_SHARED_SECRET configurada -> no hace nada (compatibilidad hacia atrás)", () => {
    delete process.env.WEBHOOK_SHARED_SECRET;
    const req = { query: {} };
    const res = fakeRes();
    let llamadoNext = false;
    verificarSecretoWebhook(req, res, () => { llamadoNext = true; });
    assert.equal(llamadoNext, true);
    assert.equal(res.statusCode, null);
});

test("con secreto configurado y query correcta -> deja pasar", () => {
    process.env.WEBHOOK_SHARED_SECRET = "abc123";
    const req = { query: { secret: "abc123" } };
    const res = fakeRes();
    let llamadoNext = false;
    verificarSecretoWebhook(req, res, () => { llamadoNext = true; });
    assert.equal(llamadoNext, true);
    delete process.env.WEBHOOK_SHARED_SECRET;
});

test("con secreto configurado y query incorrecta -> 401, no llama next", () => {
    process.env.WEBHOOK_SHARED_SECRET = "abc123";
    const req = { query: { secret: "otra-cosa" } };
    const res = fakeRes();
    let llamadoNext = false;
    verificarSecretoWebhook(req, res, () => { llamadoNext = true; });
    assert.equal(llamadoNext, false);
    assert.equal(res.statusCode, 401);
    delete process.env.WEBHOOK_SHARED_SECRET;
});

test("con secreto configurado y sin query -> 401", () => {
    process.env.WEBHOOK_SHARED_SECRET = "abc123";
    const req = { query: {} };
    const res = fakeRes();
    let llamadoNext = false;
    verificarSecretoWebhook(req, res, () => { llamadoNext = true; });
    assert.equal(llamadoNext, false);
    assert.equal(res.statusCode, 401);
    delete process.env.WEBHOOK_SHARED_SECRET;
});

test("compararSeguro: longitudes distintas -> false, nunca revienta", () => {
    assert.equal(compararSeguro("corto", "muchomaslargoquecorto"), false);
});

test("compararSeguro: valores iguales -> true", () => {
    assert.equal(compararSeguro("mismo-valor", "mismo-valor"), true);
});

// ── validarPayloadWebhook ──

test("payload objeto plano válido -> deja pasar", () => {
    const req = { body: { phone: "5511999999999", type: "ReceivedCallback" } };
    const res = fakeRes();
    let llamadoNext = false;
    validarPayloadWebhook(req, res, () => { llamadoNext = true; });
    assert.equal(llamadoNext, true);
});

test("payload null -> 400", () => {
    const req = { body: null };
    const res = fakeRes();
    let llamadoNext = false;
    validarPayloadWebhook(req, res, () => { llamadoNext = true; });
    assert.equal(llamadoNext, false);
    assert.equal(res.statusCode, 400);
});

test("payload array -> 400 (Z-API nunca manda un array en el body)", () => {
    const req = { body: [1, 2, 3] };
    const res = fakeRes();
    let llamadoNext = false;
    validarPayloadWebhook(req, res, () => { llamadoNext = true; });
    assert.equal(llamadoNext, false);
    assert.equal(res.statusCode, 400);
});

test("payload string -> 400", () => {
    const req = { body: "no-soy-un-objeto" };
    const res = fakeRes();
    let llamadoNext = false;
    validarPayloadWebhook(req, res, () => { llamadoNext = true; });
    assert.equal(llamadoNext, false);
    assert.equal(res.statusCode, 400);
});
