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

const STRING = Object.freeze({ type: "string" });
const NUMBER = Object.freeze({ type: "number" });
const STRING_ARRAY = Object.freeze({ type: "array", items: STRING });
const IMPACT_PROPERTIES = Object.freeze(Object.fromEntries(
    ["cercania", "objecion", "confianza", "alcance", "oportunidad"].map(key => [key, { type: "integer", minimum: 0, maximum: 3 }])
));
const SCHEMAS = Object.freeze({
    redaccion: {
        type: "object", additionalProperties: false,
        properties: { titulo: STRING, cuerpo: STRING, aporte: STRING },
        required: ["titulo", "cuerpo", "aporte"]
    },
    seleccion: {
        type: "object", additionalProperties: false,
        properties: {
            evaluaciones: {
                type: "array", items: {
                    type: "object", additionalProperties: false,
                    properties: {
                        id: STRING,
                        agrupa: STRING_ARRAY,
                        categoria: { anyOf: [{ type: "string", enum: ["noticias", "tasas", "economia", "bancos", "remesas", "vuelos", "apagones", "oficial"] }, { type: "null" }] },
                        puntuaciones: { type: "object", additionalProperties: false, properties: IMPACT_PROPERTIES,
                            required: Object.keys(IMPACT_PROPERTIES) },
                        aporte: STRING
                    }, required: ["id", "agrupa", "categoria", "puntuaciones", "aporte"]
                }
            }
        }, required: ["evaluaciones"]
    },
    decision: {
        type: "object", additionalProperties: false,
        properties: {
            accion: { type: "string", enum: ["CREAR", "MANTENER", "REEMPLAZAR", "RETIRAR", "SIN_DECISION"] },
            estrategiaElegidaId: { anyOf: [STRING, { type: "null" }] },
            alternativas: { type: "array", items: {
                type: "object", additionalProperties: false,
                properties: {
                    id: STRING, nombre: STRING, mecanismo: STRING, problema: STRING, evidenciaIds: STRING_ARRAY,
                    causaProbable: STRING, justificacion: STRING, accionRecomendada: STRING, resultadoEsperado: STRING,
                    impacto: NUMBER, viabilidad: NUMBER, riesgo: NUMBER, confianza: NUMBER,
                    costo: { type: "object", additionalProperties: false,
                        properties: { tipo: { type: "string", enum: ["SIN_COSTO", "OPERATIVO", "ECONOMICO", "DESCONOCIDO"] },
                            estimacion: { anyOf: [NUMBER, { type: "null" }] }, baseVerificada: { type: "boolean" }, explicacion: STRING },
                        required: ["tipo", "estimacion", "baseVerificada", "explicacion"] },
                    oferta: { type: "object", additionalProperties: false,
                        properties: { tipo: { type: "string", enum: ["NINGUNA", "DESCUENTO_TRANSFERENCIA", "MEJORA_TASA"] }, porcentaje: { type: "integer", enum: [0, 1, 2] } },
                        required: ["tipo", "porcentaje"] },
                    requiereCompromisoEconomico: { type: "boolean" }, ejecutable: { type: "boolean" }, recursos: STRING_ARRAY,
                    pasos: STRING_ARRAY,
                    destinatarios: { type: "object", additionalProperties: false,
                        properties: { criterio: STRING, basadoEnDatos: { type: "boolean" } }, required: ["criterio", "basadoEnDatos"] },
                    materiales: { type: "array", items: { type: "object", additionalProperties: false,
                        properties: { tipo: { type: "string", enum: ["biblioteca", "whatsapp", "bot", "otro"] }, titulo: STRING, contenido: STRING },
                        required: ["tipo", "titulo", "contenido"] } },
                    metricas: STRING_ARRAY, capacidadesFaltantes: STRING_ARRAY
                },
                required: ["id", "nombre", "mecanismo", "problema", "evidenciaIds", "causaProbable", "justificacion",
                    "accionRecomendada", "resultadoEsperado", "impacto", "viabilidad", "riesgo", "confianza", "costo",
                    "oferta", "requiereCompromisoEconomico", "ejecutable", "recursos", "pasos", "destinatarios", "materiales",
                    "metricas", "capacidadesFaltantes"]
            } },
            ventajaCambio: NUMBER,
            motivoCambio: { anyOf: [{ type: "string", enum: ["OPORTUNIDAD_SUPERIOR", "EVIDENCIA_INVALIDA", "NO_EJECUTABLE", "CAMBIO_MATERIAL"] }, { type: "null" }] },
            explicacionCambio: STRING
        },
        required: ["accion", "estrategiaElegidaId", "alternativas", "ventajaCambio", "motivoCambio", "explicacionCambio"]
    }
});

let client = null;

function getClient() {
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY no está configurada.");
    // The SDK retries some failures automatically. That can duplicate a paid
    // analysis without producing a second application usage row.
    client = client || new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0 });
    return client;
}

function validateSchema(value, schema, path = "$") {
    if (schema.anyOf) {
        const valid = schema.anyOf.some(candidate => {
            try { validateSchema(value, candidate, path); return true; } catch (_) { return false; }
        });
        if (!valid) throw new Error(`${path} no cumple ninguna variante del esquema.`);
        return;
    }
    if (schema.enum && !schema.enum.some(option => option === value)) throw new Error(`${path} no es un valor permitido.`);
    if (schema.type === "null") {
        if (value !== null) throw new Error(`${path} debe ser null.`);
        return;
    }
    if (schema.type === "object") {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} debe ser un objeto.`);
        for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} es obligatorio.`);
        if (schema.additionalProperties === false) {
            const extras = Object.keys(value).filter(key => !Object.hasOwn(schema.properties || {}, key));
            if (extras.length) throw new Error(`${path} contiene propiedades no permitidas: ${extras.join(", ")}.`);
        }
        for (const [key, child] of Object.entries(schema.properties || {})) {
            if (Object.hasOwn(value, key)) validateSchema(value[key], child, `${path}.${key}`);
        }
        return;
    }
    if (schema.type === "array") {
        if (!Array.isArray(value)) throw new Error(`${path} debe ser una lista.`);
        value.forEach((item, index) => validateSchema(item, schema.items || {}, `${path}[${index}]`));
        return;
    }
    if (schema.type === "string" && typeof value !== "string") throw new Error(`${path} debe ser texto.`);
    if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`${path} debe ser booleano.`);
    if ((schema.type === "number" || schema.type === "integer") && (typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error(`${path} debe ser numérico.`);
    }
    if (schema.type === "integer" && !Number.isInteger(value)) throw new Error(`${path} debe ser entero.`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} es menor que el mínimo permitido.`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} supera el máximo permitido.`);
}

async function completeJson({ tarea, system, user, temperature = 0.2, analysisId = null, contextMetrics = {}, openaiClient = null, responseSchema = null, usageService = aiUsage }) {
    const model = MODELS[tarea];
    if (!model) throw new Error(`Tarea de modelo desconocida: ${tarea}`);
    const schema = responseSchema || SCHEMAS[tarea];
    if (!schema) throw new Error(`La tarea ${tarea} no tiene un esquema JSON definido.`);
    const outputLimit = usageService.maxOutputTokens();
    const contextHash = createHash("sha256").update(`${model}\n${JSON.stringify(schema)}\n${system || ""}\n${user || ""}`).digest("hex");
    if (tarea === "decision" || tarea === "seleccion") {
        const cached = await usageService.getCachedResponse(contextHash, tarea);
        if (cached) return { data: cached.data, model: cached.model, usage: null, cacheHit: true, usageId: cached.usageId };
    }
    const reservation = await usageService.reserve({ tarea, modelo: model, system, user, analysisId: analysisId || undefined,
        contextHash, contextMetrics, outputLimit });
    if (reservation.cacheHit) return { data: reservation.data, model: reservation.model, usage: null, cacheHit: true, usageId: reservation.id };
    let response = null;
    try {
        response = await (openaiClient || getClient()).chat.completions.create({
            model,
            temperature,
            max_tokens: outputLimit,
            response_format: { type: "json_schema", json_schema: {
                name: `yorda_${tarea}`,
                strict: true,
                schema
            } },
            messages: [
                { role: "system", content: system },
                { role: "user", content: user }
            ]
        }, { timeout: 90000 });
        const choice = response.choices?.[0];
        const message = choice?.message || {};
        const text = message.content || "";
        if (message.refusal) throw new Error(`El modelo rechazó la tarea (${tarea}).`);
        if (choice?.finish_reason === "length") throw new Error(`La respuesta estructurada de ${tarea} excedió el límite de salida.`);
        if (!text) throw new Error(`El modelo (${tarea}) devolvió una respuesta vacía.`);
        let data;
        try { data = JSON.parse(text); }
        catch (_) { throw new Error(`El modelo (${tarea}) no devolvió JSON válido.`); }
        try { validateSchema(data, schema); }
        catch (error) { throw new Error(`La respuesta del modelo (${tarea}) no cumple el esquema: ${error.message}`); }
        await usageService.settle(reservation.id, { usage: response.usage || null, model: response.model, tarea,
            responseChars: text.length, cacheResponse: tarea === "redaccion" ? null : data });
        return { data, model: response.model, usage: response.usage || null, cacheHit: false,
            usageId: reservation.id };
    } catch (error) {
        await usageService.settle(reservation.id, { error, tarea, usage: response?.usage || null, model: response?.model,
            responseChars: response?.choices?.[0]?.message?.content?.length ?? null }).catch(recordError => {
            console.error("❌ No se pudo registrar consumo del Director IA:", recordError.message);
        });
        throw error;
    }
}

module.exports = { MODELS, SCHEMAS, validateSchema, completeJson };
