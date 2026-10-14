"use strict";

// Pasarela de modelos del Director IA. Todas las etapas piden JSON por aquí
// y nunca llaman al SDK directamente, para poder cambiar de modelo o de
// proveedor sin tocar el resto.
const OpenAI = require("openai");
const { createHash } = require("node:crypto");
const env = require("../../config/env");
const aiUsage = require("./ai-usage");

const MODELS = Object.freeze({
    seleccion: env.DIRECTOR_MODEL_SELECT,
    decision: env.DIRECTOR_MODEL_SELECT,
    redaccion: env.DIRECTOR_MODEL_WRITE
});

let client = null;

function getClient() {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY no está configurada.");
    // The SDK retries some failures automatically. That can duplicate a paid
    // analysis without producing a second application usage row.
    client = client || new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0 });
    return client;
}

async function completeJson({ tarea, system, user, temperature = 0.2, analysisId = null, contextMetrics = {} }) {
    const model = MODELS[tarea];
    if (!model) throw new Error(`Tarea de modelo desconocida: ${tarea}`);
    const outputLimit = aiUsage.maxOutputTokens();
    const contextHash = createHash("sha256").update(`${model}\n${system || ""}\n${user || ""}`).digest("hex");
    if (tarea === "decision" || tarea === "seleccion") {
        const cached = await aiUsage.getCachedResponse(contextHash, tarea);
        if (cached) return { data: cached.data, model: cached.model, usage: null, cacheHit: true, usageId: cached.usageId };
    }
    const reservation = await aiUsage.reserve({ tarea, modelo: model, system, user, analysisId: analysisId || undefined,
        contextHash, contextMetrics, outputLimit });
    if (reservation.cacheHit) return { data: reservation.data, model: reservation.model, usage: null, cacheHit: true, usageId: reservation.id };
    let response = null;
    try {
        response = await getClient().chat.completions.create({
            model,
            temperature,
            max_tokens: outputLimit,
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: system },
                { role: "user", content: user }
            ]
        }, { timeout: 90000 });
        const text = response.choices?.[0]?.message?.content || "";
        let data;
        try { data = JSON.parse(text); }
        catch (_) { throw new Error(`El modelo (${tarea}) no devolvió JSON válido.`); }
        await aiUsage.settle(reservation.id, { usage: response.usage || null, model: response.model, tarea,
            responseChars: text.length, cacheResponse: tarea === "redaccion" ? null : data });
        return { data, model: response.model, usage: response.usage || null, cacheHit: false,
            usageId: reservation.id };
    } catch (error) {
        await aiUsage.settle(reservation.id, { error, tarea, usage: response?.usage || null, model: response?.model,
            responseChars: response?.choices?.[0]?.message?.content?.length ?? null }).catch(recordError => {
            console.error("❌ No se pudo registrar consumo del Director IA:", recordError.message);
        });
        throw error;
    }
}

module.exports = { MODELS, completeJson };
