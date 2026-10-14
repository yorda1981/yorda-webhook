"use strict";

const pool = require("../../db");

const SUPPORTED_LANGUAGES = Object.freeze(["es", "pt"]);

function selectorValidationError(message) {
    const error = new Error(message);
    error.code = "CONTENT_SELECTOR_VALIDATION";
    return error;
}

function normalizeLanguage(value) {
    const language = String(value || "es").trim().toLowerCase();
    if (!SUPPORTED_LANGUAGES.includes(language)) {
        throw selectorValidationError("Idioma no soportado. Usa 'es' o 'pt'.");
    }
    return language;
}

// Opcional: restringe la selección a un activo concreto (p. ej. publicar
// desde la Biblioteca). Sin contentId se mantiene la selección automática.
function normalizeContentId(value) {
    if (value === undefined || value === null || value === "") return null;
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) {
        throw selectorValidationError("Identificador de contenido inválido.");
    }
    return id;
}

function mapSelection(row) {
    if (!row) return null;
    return {
        contentId: Number(row.id),
        revisionId: Number(row.revision_id),
        revision: Number(row.revision_numero),
        titulo: row.titulo,
        cuerpo: row.cuerpo,
        estado: row.estado,
        idioma: row.idioma,
        prioridad: Number(row.prioridad),
        ultimaUtilizacionAt: row.ultima_utilizacion_at,
        criterio: "PRIORIDAD_Y_MENOR_USO"
    };
}

async function selectContent(criteria = {}, db = pool) {
    const language = normalizeLanguage(criteria.idioma);
    const contentId = normalizeContentId(criteria.contentId);
    // Un activo concreto se publica en su propio idioma; el idioma solo filtra la selección automática.
    const filter = contentId ? "ci.id = $1" : "ci.idioma = $1";
    const result = await db.query(`
        SELECT ci.id, ci.titulo, ci.estado, ci.idioma, ci.prioridad,
               ci.ultima_utilizacion_at,
               cr.id AS revision_id, cr.numero AS revision_numero, cr.cuerpo
        FROM content_items ci
        JOIN LATERAL (
            SELECT id, numero, cuerpo
            FROM content_revisions
            WHERE content_item_id = ci.id
            ORDER BY numero DESC
            LIMIT 1
        ) cr ON TRUE
        WHERE ci.estado = 'ACTIVO'
          AND ${filter}
          -- BORRADOR nunca entra por estado; activos del Director solo se
          -- vuelven elegibles después de aprobación explícita.
        ORDER BY
          ci.prioridad DESC,
          ci.ultima_utilizacion_at ASC NULLS FIRST,
          ci.id ASC
        LIMIT 1
    `, [contentId || language]);
    return mapSelection(result.rows[0]);
}

module.exports = {
    SUPPORTED_LANGUAGES,
    normalizeLanguage,
    normalizeContentId,
    mapSelection,
    selectContent
};
