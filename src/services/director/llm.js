"use strict";

// Pasarela de modelos del Director IA. Todas las etapas piden JSON por aquí
// y nunca llaman al SDK directamente, para poder cambiar de modelo o de
// proveedor sin tocar el resto.
const OpenAI = require("openai");
const env = require("../../config/env");

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

async function completeJson({ tarea, system, user, temperature = 0.2 }) {
    const model = MODELS[tarea];
    if (!model) throw new Error(`Tarea de modelo desconocida: ${tarea}`);
    const response = await getClient().chat.completions.create({
        model,
        temperature,
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: system },
            { role: "user", content: user }
        ]
    }, { timeout: 90000 });
    const text = response.choices?.[0]?.message?.content || "";
    try {
        return { data: JSON.parse(text), model: response.model, usage: response.usage || null };
    } catch (_) {
        throw new Error(`El modelo (${tarea}) no devolvió JSON válido.`);
    }
}

module.exports = { MODELS, completeJson };
