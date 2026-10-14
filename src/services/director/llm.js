"use strict";

// Pasarela de modelos del Director IA. Todas las etapas piden JSON por aquí
// y nunca llaman al SDK directamente, para poder cambiar de modelo o de
// proveedor sin tocar el resto.
const OpenAI = require("openai");
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
    client = client || new OpenAI({ apiKey: env.OPENAI_API_KEY });
    return client;
}

async function completeJson({ tarea, system, user, temperature = 0.2, analysisId = null }) {
    const model = MODELS[tarea];
    if (!model) throw new Error(`Tarea de modelo desconocida: ${tarea}`);
    const reservation = await aiUsage.reserve({ tarea, modelo: model, system, user, analysisId: analysisId || undefined });
    try {
        const response = await getClient().chat.completions.create({
            model,
            temperature,
            max_tokens: 3000,
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
        await aiUsage.settle(reservation.id, { usage: response.usage || null, model: response.model, tarea });
        return { data, model: response.model, usage: response.usage || null };
    } catch (error) {
        await aiUsage.settle(reservation.id, { error, tarea }).catch(recordError => {
            console.error("❌ No se pudo registrar consumo del Director IA:", recordError.message);
        });
        throw error;
    }
}

module.exports = { MODELS, completeJson };
