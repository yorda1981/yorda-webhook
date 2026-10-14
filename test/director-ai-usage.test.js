"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const usage = require("../src/services/director/ai-usage");
const referral = require("../src/services/director/referral-economics");

test("los escenarios de referidos calculan 1 % y mantienen beneficio como no verificado", () => {
    const result = referral.evaluateReferralEconomics();
    assert.equal(result.authorized, false);
    assert.equal(result.scenarios[0].rewardBRL, 1);
    assert.equal(result.scenarios[0].remainingReferenceBRL, 4);
    assert.equal(result.scenarios[1].rewardBRL, 5);
    assert.equal(result.scenarios[1].netProfitVerified, false);
    assert.ok(result.missing.some(item => /costos reales/i.test(item)));
});

test("el costo de IA se calcula solo cuando se configuran precios del proveedor", () => {
    assert.deepEqual(usage.costFromUsage({ prompt_tokens: 1_000_000, completion_tokens: 500_000 }, null),
        { cost: null, available: false });
    assert.deepEqual(usage.costFromUsage({ prompt_tokens: 1_000_000, completion_tokens: 500_000 }, { prompt: 2, completion: 8 }),
        { cost: 6, available: true });
    assert.deepEqual(usage.configuredRates({ DIRECTOR_PRICE_INPUT_USD_PER_MILLION_SELECT: "1",
        DIRECTOR_PRICE_OUTPUT_USD_PER_MILLION_SELECT: "3" }, "decision"), { prompt: 1, completion: 3 });
    assert.equal(usage.configuredRates({ DIRECTOR_PRICE_INPUT_USD_PER_MILLION_SELECT: "1",
        DIRECTOR_PRICE_OUTPUT_USD_PER_MILLION_SELECT: "3" }, "redaccion"), null);
});

test("el preflight reserva tokens de entrada y el máximo de salida configurable sin superar el techo", () => {
    assert.equal(usage.maxOutputTokens({ DIRECTOR_MAX_OUTPUT_TOKENS: "900" }), 900);
    assert.equal(usage.maxOutputTokens({ DIRECTOR_MAX_OUTPUT_TOKENS: "9000" }), 3000);
    assert.equal(usage.maxOutputTokens({}), 1800);
    assert.equal(usage.estimateTokens("a".repeat(300), "b".repeat(300), 900), 1140);
});

test("reutiliza un resultado equivalente y registra el hit sin hacer otra llamada al proveedor", async () => {
    const calls = [];
    const db = { query: async (sql, params) => {
        calls.push({ sql: String(sql), params });
        return /SELECT id, modelo/.test(sql) ? { rows: [{ id: 4, modelo: "gpt-4o-mini", metadata: { cachedResponse: { accion: "MANTENER" } } }] } : { rows: [] };
    } };
    const cached = await usage.getCachedResponse("hash", "decision", db);
    assert.deepEqual(cached, { model: "gpt-4o-mini", data: { accion: "MANTENER" } });
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /contextHash/);
    assert.match(calls[1].sql, /cacheHits/);
});

test("un costo no configurado queda NULL (no cero) y el razonamiento no informado queda explícitamente desconocido", async () => {
    let update;
    await usage.settle(9, { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }, model: "test",
        tarea: "decision", db: { query: async (_sql, params) => { update = params; return { rows: [] }; } }, env: {} });
    assert.equal(update[5], null, "costo no inventado");
    assert.equal(update[6], false, "costo marcado como no disponible");
    const metadata = JSON.parse(update[8]);
    assert.equal(metadata.reasoningTokens, null);
    assert.equal(metadata.providerUsageBreakdownAvailable, false);
});

test("la reserva de IA respeta el límite de llamadas antes de llamar al proveedor", async () => {
    const statements = [];
    const client = { query: async (sql) => {
        statements.push(String(sql));
        if (/SELECT COUNT/.test(sql)) return { rows: [{ calls: 2, tokens: 1000 }] };
        if (/INSERT INTO director_ai_usage/.test(sql)) return { rows: [{ id: 15 }] };
        return { rows: [] };
    }, release() {} };
    const db = { connect: async () => client };
    const reservation = await usage.reserve({ tarea: "decision", modelo: "test", system: "system", user: "user", db,
        env: { DIRECTOR_DAILY_CALL_LIMIT: "3", DIRECTOR_DAILY_TOKEN_LIMIT: "50000" } });
    assert.equal(reservation.id, 15);
    assert.match(statements.join(" "), /pg_advisory_xact_lock/);

    const limitedClient = { query: async sql => /SELECT COUNT/.test(sql)
        ? { rows: [{ calls: 3, tokens: 1000 }] } : { rows: [] }, release() {} };
    await assert.rejects(() => usage.reserve({ tarea: "decision", modelo: "test", system: "s", user: "u",
        db: { connect: async () => limitedClient }, env: { DIRECTOR_DAILY_CALL_LIMIT: "3" } }),
    error => error.code === "DIRECTOR_DAILY_CALL_LIMIT");
});

test("una reserva concurrente equivalente se bloquea antes de abrir otra llamada", async () => {
    const statements = [];
    const client = { query: async (sql) => {
        statements.push(String(sql));
        if (/SELECT id, modelo, resultado, metadata, creado_at/.test(sql)) return { rows: [{ id: 22, modelo: "gpt-4o-mini",
            resultado: "PENDIENTE", creado_at: new Date(), metadata: {} }] };
        return { rows: [] };
    }, release() {} };
    await assert.rejects(() => usage.reserve({ tarea: "decision", modelo: "gpt-4o-mini", system: "s", user: "u",
        contextHash: "same", db: { connect: async () => client } }),
    error => error.code === "DIRECTOR_EQUIVALENT_ANALYSIS_IN_PROGRESS");
    assert.match(statements[1], /pg_advisory_xact_lock/);
    assert.ok(statements.some(sql => /INSERT INTO director_ai_usage/.test(sql) && /BLOQUEADO/.test(sql)));
    assert.equal(statements.some(sql => /SELECT COUNT/.test(sql)), false);
});
