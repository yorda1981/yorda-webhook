"use strict";

// Configuración comercial del Director IA, versionada en director_config.
// Nada de esto es una regla permanente del código: la fila más reciente es
// la vigente, y cada cambio deja registrado su motivo para poder ajustar la
// estrategia con resultados reales en lugar de opiniones.

const pool = require("../../../db");

// Familias de contenido sobre las que se reparte la mezcla.
const FAMILIES = Object.freeze({
    actualidad: "Actualidad (noticias, tasas, economía, bancos, vuelos, apagones, cambios oficiales)",
    educacion: "Educación (cómo funciona, uso del bot, pago, entrega, datos, errores, preguntas)",
    confianza: "Confianza (seguridad y protección del cliente)"
});

// Respaldo si la tabla todavía no tiene filas; es la misma propuesta inicial de la migración.
const DEFAULT_CONFIG = Object.freeze({
    version: 0,
    mezcla: { actualidad: 45, educacion: 40, confianza: 15 },
    umbralImpacto: 55,
    maxBorradores: 5,
    ventanaDias: 14,
    ajusteMaximo: 15,
    penalizacionRepeticion: 5,
    diasAlertaSinBorradores: 3,
    motivo: "Configuración inicial propuesta sin datos reales.",
    creadoPor: "sistema",
    creadoAt: null
});

const LIMITS = Object.freeze({
    umbralImpacto: [0, 100],
    maxBorradores: [1, 10],
    ventanaDias: [7, 90],
    ajusteMaximo: [0, 30],
    penalizacionRepeticion: [0, 15],
    diasAlertaSinBorradores: [1, 30]
});

function configError(message) {
    const error = new Error(message);
    error.code = "CONTENT_DIRECTOR_VALIDATION";
    return error;
}

function mapConfig(row) {
    if (!row) return { ...DEFAULT_CONFIG, mezcla: { ...DEFAULT_CONFIG.mezcla } };
    return {
        version: Number(row.id),
        mezcla: row.mezcla,
        umbralImpacto: Number(row.umbral_impacto),
        maxBorradores: Number(row.max_borradores),
        ventanaDias: Number(row.ventana_dias),
        ajusteMaximo: Number(row.ajuste_maximo),
        penalizacionRepeticion: Number(row.penalizacion_repeticion),
        diasAlertaSinBorradores: Number(row.dias_alerta_sin_borradores),
        motivo: row.motivo,
        creadoPor: row.creado_por,
        creadoAt: row.creado_at
    };
}

async function getActiveConfig(db = pool) {
    const result = await db.query("SELECT * FROM director_config ORDER BY id DESC LIMIT 1");
    return mapConfig(result.rows[0]);
}

async function getConfigHistory(db = pool, limit = 10) {
    const result = await db.query("SELECT * FROM director_config ORDER BY id DESC LIMIT $1", [limit]);
    return result.rows.map(mapConfig);
}

function normalizeConfig(input, current) {
    const merged = { ...current, ...input, mezcla: { ...current.mezcla, ...(input?.mezcla || {}) } };
    const mezcla = {};
    for (const family of Object.keys(FAMILIES)) {
        const value = Number(merged.mezcla[family]);
        if (!Number.isInteger(value) || value < 0 || value > 100) throw configError(`La mezcla de «${family}» debe ser un entero entre 0 y 100.`);
        mezcla[family] = value;
    }
    const unknown = Object.keys(merged.mezcla).filter(key => !FAMILIES[key]);
    if (unknown.length) throw configError(`Familias desconocidas en la mezcla: ${unknown.join(", ")}.`);
    if (Object.values(mezcla).reduce((sum, value) => sum + value, 0) !== 100) throw configError("La mezcla debe sumar 100.");
    const config = { mezcla };
    for (const [field, [min, max]] of Object.entries(LIMITS)) {
        const value = Number(merged[field]);
        if (!Number.isInteger(value) || value < min || value > max) throw configError(`«${field}» debe ser un entero entre ${min} y ${max}.`);
        config[field] = value;
    }
    const motivo = String(input?.motivo || "").trim();
    if (motivo.length < 10) throw configError("Explica el motivo del cambio (por ejemplo, qué resultado lo justifica).");
    config.motivo = motivo.slice(0, 1000);
    return config;
}

// Cada cambio crea una versión nueva; nunca se edita la anterior.
async function saveConfig(input, db = pool) {
    const current = await getActiveConfig(db);
    const config = normalizeConfig(input, current);
    const result = await db.query(`
        INSERT INTO director_config (mezcla, umbral_impacto, max_borradores, ventana_dias, ajuste_maximo,
                                     penalizacion_repeticion, dias_alerta_sin_borradores, motivo, creado_por)
        VALUES ($1::jsonb, $2, $3, $4, $5, $6, $7, $8, 'admin')
        RETURNING *
    `, [JSON.stringify(config.mezcla), config.umbralImpacto, config.maxBorradores, config.ventanaDias,
        config.ajusteMaximo, config.penalizacionRepeticion, config.diasAlertaSinBorradores, config.motivo]);
    return mapConfig(result.rows[0]);
}

module.exports = { FAMILIES, DEFAULT_CONFIG, getActiveConfig, getConfigHistory, normalizeConfig, saveConfig };
