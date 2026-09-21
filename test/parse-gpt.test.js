"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — parseGPT (src/flows/shared.js)
//
// Esta función es el único punto donde la respuesta de OpenAI (OCR de
// imagen/PDF) se convierte en el objeto que usa el resto del flujo de
// dinero (comprobante PIX válido, comprobante no reconocido, tarjeta
// cubana). No llama a OpenAI real — solo prueba qué pasa con distintas
// respuestas de texto ya recibidas.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseGPT } = require("../src/flows/shared");

test("comprobante PIX válido: JSON limpio se parsea tal cual", () => {
    const texto = '{"tipo":"comprovante_pix","valor":200,"fecha":"01/09/2026","hora":"10:30","banco":"Nubank","destinatario":"Yordanys","destino_correcto":true,"valido":true}';
    const r = parseGPT(texto);
    assert.equal(r.tipo, "comprovante_pix");
    assert.equal(r.valor, 200);
    assert.equal(r.destino_correcto, true);
});

test("comprobante PIX: GPT envuelve el JSON en fences ```json ... ``` -> igual se parsea", () => {
    const texto = "```json\n{\"tipo\":\"comprovante_pix\",\"valor\":150,\"valido\":true}\n```";
    const r = parseGPT(texto);
    assert.equal(r.tipo, "comprovante_pix");
    assert.equal(r.valor, 150);
});

test("comprobante PIX: fences sin la palabra json -> también se parsea", () => {
    const texto = "```\n{\"tipo\":\"comprovante_pix\",\"valor\":75}\n```";
    const r = parseGPT(texto);
    assert.equal(r.tipo, "comprovante_pix");
});

test("tarjeta cubana: JSON de tarjeta se parsea tal cual", () => {
    const texto = '{"tipo":"tarjeta","tarjeta":"9218123456789012","titular":"YORDANYS SOSA","banco":"bandec","valida":true}';
    const r = parseGPT(texto);
    assert.equal(r.tipo, "tarjeta");
    assert.equal(r.tarjeta, "9218123456789012");
});

test("no reconocido: {\"tipo\":\"otro\"} se parsea igual que cualquier otro JSON válido", () => {
    const r = parseGPT('{"tipo":"otro"}');
    assert.equal(r.tipo, "otro");
});

test("respuesta no-JSON de GPT (texto libre / rechazo del modelo) -> objeto vacío, nunca revienta", () => {
    const r = parseGPT("Lo siento, no puedo procesar esta imagen.");
    assert.deepEqual(r, {});
});

test("respuesta vacía -> objeto vacío", () => {
    assert.deepEqual(parseGPT(""), {});
});

test("null/undefined -> objeto vacío, nunca revienta", () => {
    assert.deepEqual(parseGPT(null), {});
    assert.deepEqual(parseGPT(undefined), {});
});

test("JSON truncado (respuesta cortada por max_tokens) -> objeto vacío, no revienta", () => {
    const r = parseGPT('{"tipo":"comprovante_pix","valor":200,"fecha":"01/09');
    assert.deepEqual(r, {});
});

test("JSON con espacios y saltos de línea alrededor -> se parsea igual", () => {
    const r = parseGPT('\n\n  {"tipo":"otro"}  \n');
    assert.equal(r.tipo, "otro");
});
