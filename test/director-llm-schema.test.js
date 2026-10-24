"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const llm = require("../src/services/director/llm");

function usageService() {
    const calls = [];
    return { calls, maxOutputTokens: () => 300, reserve: async () => ({ id: "usage-1" }),
        settle: async (...args) => calls.push(args), getCachedResponse: async () => null };
}

test("todas las respuestas del Director tienen esquema cerrado y validación local", () => {
    for (const schema of Object.values(llm.SCHEMAS)) {
        assert.equal(schema.type, "object");
        assert.equal(schema.additionalProperties, false);
        assert.deepEqual([...Object.keys(schema.properties)].sort(), [...schema.required].sort());
    }
    assert.throws(() => llm.validateSchema({ titulo: "x", cuerpo: "y", aporte: "z", extra: true }, llm.SCHEMAS.redaccion), /no permitidas/);
});

test("el modelo recibe JSON Schema estricto y la aplicación valida la respuesta", async () => {
    const usage = usageService();
    let request;
    const result = await llm.completeJson({ tarea: "redaccion", system: "system", user: "user", usageService: usage,
        openaiClient: { chat: { completions: { create: async value => {
            request = value;
            return { model: "test-model", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ titulo: "Guía", cuerpo: "Contenido comprobado", aporte: "Aclara el proceso" }) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } };
        } } } } });
    assert.equal(request.response_format.type, "json_schema");
    assert.equal(request.response_format.json_schema.strict, true);
    assert.equal(result.data.titulo, "Guía");
    assert.equal(usage.calls.length, 1);
    assert.equal(usage.calls[0][1].usage.prompt_tokens, 20);
});

test("JSON o contenido que no cumple el esquema se rechaza sin reintentos", async () => {
    const usage = usageService();
    let calls = 0;
    await assert.rejects(() => llm.completeJson({ tarea: "redaccion", system: "s", user: "u", usageService: usage,
        openaiClient: { chat: { completions: { create: async () => { calls++; return { choices: [{ finish_reason: "stop", message: { content: "{malformed" } }] }; } } } } }), /JSON válido/);
    assert.equal(calls, 1);
    assert.equal(usage.calls.length, 1);
});
