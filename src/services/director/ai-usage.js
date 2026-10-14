"use strict";

const pool = require("../../../db");
const { randomUUID } = require("node:crypto");

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function maxOutputTokens(env = process.env) {
    // The model output cap is configurable downward/upward only to the audited
    // ceiling; a deployment variable must not silently expand the daily budget.
    return Math.min(3000, positiveInt(env.DIRECTOR_MAX_OUTPUT_TOKENS, 1800));
}

function estimateTokens(system, user, outputLimit = maxOutputTokens()) {
    // Reserve the complete output allowance so the daily token cap is enforced
    // before the paid request; the provider's actual usage replaces it later.
    // Conservative preflight heuristic (not a provider-measured token count).
    return Math.ceil((String(system || "").length + String(user || "").length) / 2.5) + outputLimit;
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

async function reserve({ tarea, modelo, system, user, analysisId = randomUUID(), db = pool, env = process.env,
    contextHash = null, contextMetrics = {}, outputLimit = maxOutputTokens(env) }) {
    const estimate = estimateTokens(system, user, outputLimit);
    const tokenLimit = positiveInt(env.DIRECTOR_DAILY_TOKEN_LIMIT, 50000);
    const callLimit = positiveInt(env.DIRECTOR_DAILY_CALL_LIMIT, 12);
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('director-ai-daily-budget'))");
        if ((tarea === "decision" || tarea === "seleccion") && contextHash) {
            const equivalent = await client.query(`SELECT id, modelo, resultado, metadata, creado_at FROM director_ai_usage
                WHERE tarea = $2 AND metadata->>'contextHash' = $1
                  AND (resultado = 'PENDIENTE' OR (resultado = 'COMPLETADO' AND metadata->>'cacheable' = 'true' AND metadata ? 'cachedResponse'))
                ORDER BY creado_at DESC LIMIT 1`, [contextHash, tarea]);
            const prior = equivalent.rows[0];
            if (prior?.resultado === "COMPLETADO") {
                await client.query(`UPDATE director_ai_usage SET metadata = jsonb_set(metadata,
                    '{cacheHits}', to_jsonb(COALESCE((metadata->>'cacheHits')::int, 0) + 1), true) WHERE id = $1`, [prior.id]);
                await client.query("COMMIT");
                return { id: prior.id, estimate, tarea, cacheHit: true, model: prior.modelo, data: prior.metadata.cachedResponse };
            }
            if (prior?.resultado === "PENDIENTE") {
                const pendingAgeMs = Date.now() - new Date(prior.creado_at).getTime();
                if (Number.isFinite(pendingAgeMs) && pendingAgeMs < 10 * 60 * 1000) {
                    await client.query(`INSERT INTO director_ai_usage (analysis_id, tarea, modelo, estimated_tokens, resultado, metadata)
                        VALUES ($1,$2,$3,0,'BLOQUEADO',$4::jsonb)`, [analysisId, tarea, modelo,
                        JSON.stringify({ reason: "DIRECTOR_EQUIVALENT_ANALYSIS_IN_PROGRESS", contextHash, cacheHit: false })]);
                    await client.query("COMMIT");
                    const error = new Error("Ya existe una evaluación equivalente en curso; se evita duplicarla.");
                    error.code = "DIRECTOR_EQUIVALENT_ANALYSIS_IN_PROGRESS";
                    throw error;
                }
                // A request that stayed pending past the 90s HTTP timeout is
                // an unknown outcome. Retain its token reservation and cost as
                // unknown, but don't let the stale lock suppress future work forever.
                await client.query(`UPDATE director_ai_usage SET resultado = 'ERROR',
                    metadata = metadata || $2::jsonb WHERE id = $1`, [prior.id,
                    JSON.stringify({ error: "Solicitud quedó PENDIENTE más de 10 minutos; resultado/costo del proveedor desconocidos.", cacheable: false })]);
            }
        }
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
        const projectedCost = rates ? costFromUsage({ prompt_tokens: Math.max(0, estimate - outputLimit), completion_tokens: outputLimit }, rates).cost : null;
        const reason = calls >= callLimit ? "DIRECTOR_DAILY_CALL_LIMIT"
            : tokens + estimate > tokenLimit ? "DIRECTOR_DAILY_TOKEN_LIMIT"
                : dailyCostLimit && !rates ? "DIRECTOR_DAILY_COST_PRICING_MISSING"
                    : dailyCostLimit && Number(totals.rows[0]?.unknown_cost_calls || 0) > 0 ? "DIRECTOR_DAILY_COST_UNKNOWN"
                        : dailyCostLimit && Number(totals.rows[0]?.cost_usd || 0) + projectedCost > dailyCostLimit
                            ? "DIRECTOR_DAILY_COST_LIMIT" : null;
        if (reason) {
            await client.query(`INSERT INTO director_ai_usage (analysis_id, tarea, modelo, estimated_tokens, resultado, metadata)
                VALUES ($1,$2,$3,$4,'BLOQUEADO',$5::jsonb)`, [analysisId, tarea, modelo, estimate, JSON.stringify({
                reason, calls, tokens, callLimit, tokenLimit, dailyCostLimit, projectedCost,
                inputChars: String(system || "").length + String(user || "").length,
                systemChars: String(system || "").length, userChars: String(user || "").length,
                maxOutputTokens: outputLimit, contextHash, contextMetrics, cacheHit: false
            })]);
            await client.query("COMMIT");
            const error = new Error("El análisis no se ejecutó: se alcanzó el límite diario configurable de IA.");
            error.code = reason;
            throw error;
        }
        const inserted = await client.query(`INSERT INTO director_ai_usage (analysis_id, tarea, modelo, estimated_tokens, resultado, metadata)
            VALUES ($1,$2,$3,$4,'PENDIENTE',$5::jsonb) RETURNING id`, [analysisId, tarea, modelo, estimate,
            JSON.stringify({ inputChars: String(system || "").length + String(user || "").length,
                systemChars: String(system || "").length, userChars: String(user || "").length,
                maxOutputTokens: outputLimit, contextHash, contextMetrics, cacheHit: false })]);
        await client.query("COMMIT");
        return { id: inserted.rows[0].id, estimate, tarea, cacheHit: false };
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

async function linkDecisionByUsageId(usageId, decisionId, db = pool) {
    if (!usageId || !decisionId) return;
    await db.query("UPDATE director_ai_usage SET decision_id = $2 WHERE id = $1 AND (decision_id IS NULL OR decision_id = $2)", [usageId, decisionId]);
}

async function settle(id, { usage = null, model, tarea = null, error = null, responseChars = null,
    cacheResponse = null, db = pool, env = process.env }) {
    const rates = configuredRates(env, tarea);
    const cost = costFromUsage(usage, rates);
    const details = usage?.completion_tokens_details || usage?.output_tokens_details || {};
    const promptDetails = usage?.prompt_tokens_details || usage?.input_tokens_details || {};
    const reasoningTokens = details.reasoning_tokens != null && Number.isFinite(Number(details.reasoning_tokens))
        ? Number(details.reasoning_tokens) : null;
    const providerCachedPromptTokens = promptDetails.cached_tokens != null && Number.isFinite(Number(promptDetails.cached_tokens))
        ? Number(promptDetails.cached_tokens) : null;
    await db.query(`UPDATE director_ai_usage SET modelo = COALESCE($2, modelo),
        prompt_tokens = $3, completion_tokens = $4, total_tokens = $5, costo_usd = $6,
        costo_disponible = $7, resultado = $8, metadata = metadata || $9::jsonb
        WHERE id = $1`, [id, model || null, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null,
        usage?.total_tokens ?? null, cost.cost, cost.available, error ? "ERROR" : "COMPLETADO",
        JSON.stringify(error ? { error: String(error.message || error).slice(0, 400), cacheable: false } : {
            reasoningTokens,
            responseChars,
            providerUsageBreakdownAvailable: reasoningTokens !== null,
            providerReportedPromptTokens: usage?.prompt_tokens ?? null,
            providerReportedCompletionTokens: usage?.completion_tokens ?? null,
            providerCachedPromptTokens,
            cacheable: cacheResponse !== null,
            ...(cacheResponse ? { cachedResponse: cacheResponse } : {})
        })]);
    return cost;
}

async function getCachedResponse(contextHash, tarea = "decision", db = pool) {
    if (!contextHash) return null;
    const result = await db.query(`SELECT id, modelo, metadata FROM director_ai_usage
        WHERE tarea = $2 AND resultado = 'COMPLETADO'
          AND metadata->>'contextHash' = $1 AND metadata->>'cacheable' = 'true'
          AND metadata ? 'cachedResponse'
        ORDER BY creado_at DESC LIMIT 1`, [contextHash, tarea]);
    const row = result.rows[0];
    if (!row) return null;
    await db.query(`UPDATE director_ai_usage SET metadata = jsonb_set(metadata,
        '{cacheHits}', to_jsonb(COALESCE((metadata->>'cacheHits')::int, 0) + 1), true) WHERE id = $1`, [row.id]);
    return { usageId: Number(row.id), model: row.modelo, data: row.metadata.cachedResponse };
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

module.exports = { maxOutputTokens, estimateTokens, configuredRates, configuredCostLimit, costFromUsage, reserve, settle,
    getCachedResponse, linkDecision, linkDecisionByUsageId, getDailySummary };
