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
