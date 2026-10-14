"use strict";

const pool = require("../../../db");
const { randomUUID } = require("node:crypto");

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function estimateTokens(system, user) {
    // Reserve the complete output allowance so the daily token cap is enforced
    // before the paid request; the provider's actual usage replaces it later.
    return Math.ceil((String(system || "").length + String(user || "").length) / 3.5) + 3000;
}

function priceSuffix(tarea) {
    return tarea === "redaccion" ? "WRITE" : "SELECT";
}

function configuredRates(env = process.env, tarea = null) {
    const suffix = priceSuffix(tarea);
    const input = env[`DIRECTOR_PRICE_INPUT_USD_PER_MILLION_${suffix}`];
    const output = env[`DIRECTOR_PRICE_OUTPUT_USD_PER_MILLION_${suffix}`];
    const prompt = Number(input);
    const completion = Number(output);
    if (!Number.isFinite(prompt) || prompt < 0 || !Number.isFinite(completion) || completion < 0) return null;
    if (!input || !output) return null;
    return { prompt, completion };
}

function configuredCostLimit(env = process.env) {
    if (!env.DIRECTOR_DAILY_BUDGET_USD) return null;
    const limit = Number(env.DIRECTOR_DAILY_BUDGET_USD);
    return Number.isFinite(limit) && limit > 0 ? limit : null;
}

function costFromUsage(usage, rates = configuredRates()) {
    if (!rates || !usage) return { cost: null, available: false };
    return {
        cost: (Number(usage.prompt_tokens || 0) * rates.prompt + Number(usage.completion_tokens || 0) * rates.completion) / 1_000_000,
        available: true
    };
}

async function reserve({ tarea, modelo, system, user, analysisId = randomUUID(), db = pool, env = process.env }) {
    const estimate = estimateTokens(system, user);
    const tokenLimit = positiveInt(env.DIRECTOR_DAILY_TOKEN_LIMIT, 50000);
    const callLimit = positiveInt(env.DIRECTOR_DAILY_CALL_LIMIT, 12);
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('director-ai-daily-budget'))");
        const totals = await client.query(`
            SELECT COUNT(*)::int AS calls, COALESCE(SUM(CASE WHEN resultado = 'PENDIENTE' THEN estimated_tokens
                ELSE COALESCE(total_tokens, estimated_tokens) END),0)::int AS tokens,
                COALESCE(SUM(costo_usd) FILTER (WHERE costo_disponible),0)::numeric AS cost_usd,
                COUNT(*) FILTER (WHERE resultado IN ('COMPLETADO','ERROR') AND NOT costo_disponible)::int AS unknown_cost_calls
            FROM director_ai_usage
            WHERE creado_at >= (date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')
              AND resultado IN ('PENDIENTE','COMPLETADO','ERROR')
        `);
        const calls = Number(totals.rows[0]?.calls || 0);
        const tokens = Number(totals.rows[0]?.tokens || 0);
        const dailyCostLimit = configuredCostLimit(env);
        const rates = configuredRates(env, tarea);
        const projectedCost = rates ? costFromUsage({ prompt_tokens: Math.max(0, estimate - 3000), completion_tokens: 3000 }, rates).cost : null;
        const reason = calls >= callLimit ? "DIRECTOR_DAILY_CALL_LIMIT"
            : tokens + estimate > tokenLimit ? "DIRECTOR_DAILY_TOKEN_LIMIT"
                : dailyCostLimit && !rates ? "DIRECTOR_DAILY_COST_PRICING_MISSING"
                    : dailyCostLimit && Number(totals.rows[0]?.unknown_cost_calls || 0) > 0 ? "DIRECTOR_DAILY_COST_UNKNOWN"
                        : dailyCostLimit && Number(totals.rows[0]?.cost_usd || 0) + projectedCost > dailyCostLimit
                            ? "DIRECTOR_DAILY_COST_LIMIT" : null;
        if (reason) {
            await client.query(`INSERT INTO director_ai_usage (analysis_id, tarea, modelo, estimated_tokens, resultado, metadata)
                VALUES ($1,$2,$3,$4,'BLOQUEADO',$5::jsonb)`, [analysisId, tarea, modelo, estimate, JSON.stringify({ reason, calls, tokens, callLimit, tokenLimit, dailyCostLimit, projectedCost })]);
            await client.query("COMMIT");
            const error = new Error("El análisis no se ejecutó: se alcanzó el límite diario configurable de IA.");
            error.code = reason;
            throw error;
        }
        const inserted = await client.query(`INSERT INTO director_ai_usage (analysis_id, tarea, modelo, estimated_tokens, resultado)
            VALUES ($1,$2,$3,$4,'PENDIENTE') RETURNING id`, [analysisId, tarea, modelo, estimate]);
        await client.query("COMMIT");
        return { id: inserted.rows[0].id, estimate, tarea };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

async function linkDecision(analysisId, decisionId, db = pool) {
    if (!analysisId || !decisionId) return;
    await db.query("UPDATE director_ai_usage SET decision_id = $2 WHERE analysis_id = $1", [analysisId, decisionId]);
}

async function settle(id, { usage = null, model, tarea = null, error = null, db = pool, env = process.env }) {
    const rates = configuredRates(env, tarea);
    const cost = costFromUsage(usage, rates);
    await db.query(`UPDATE director_ai_usage SET modelo = COALESCE($2, modelo),
        prompt_tokens = $3, completion_tokens = $4, total_tokens = $5, costo_usd = $6,
        costo_disponible = $7, resultado = $8, metadata = metadata || $9::jsonb
        WHERE id = $1`, [id, model || null, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null,
        usage?.total_tokens ?? null, cost.cost, cost.available, error ? "ERROR" : "COMPLETADO",
        JSON.stringify(error ? { error: String(error.message || error).slice(0, 400) } : {})]);
    return cost;
}

async function getDailySummary(db = pool) {
    const result = await db.query(`SELECT COUNT(*) FILTER (WHERE resultado IN ('COMPLETADO','ERROR'))::int AS llamadas,
        COALESCE(SUM(total_tokens),0)::bigint AS tokens,
        COUNT(*) FILTER (WHERE resultado = 'BLOQUEADO')::int AS bloqueadas,
        CASE WHEN BOOL_AND(costo_disponible) FILTER (WHERE resultado = 'COMPLETADO')
            THEN COALESCE(SUM(costo_usd),0) ELSE NULL END AS costo_usd,
        BOOL_AND(costo_disponible) FILTER (WHERE resultado = 'COMPLETADO') AS costo_disponible
        FROM director_ai_usage WHERE creado_at >=
          (date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`);
    return { ...(result.rows[0] || {}),
        limiteTokens: positiveInt(process.env.DIRECTOR_DAILY_TOKEN_LIMIT, 50000),
        limiteLlamadas: positiveInt(process.env.DIRECTOR_DAILY_CALL_LIMIT, 12),
        limiteCostoUsd: configuredCostLimit(),
        costoConfigurable: Boolean(configuredRates(process.env, "decision") && configuredRates(process.env, "redaccion")) };
}

module.exports = { estimateTokens, configuredRates, configuredCostLimit, costFromUsage, reserve, settle, linkDecision, getDailySummary };
