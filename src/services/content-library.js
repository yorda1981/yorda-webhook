"use strict";

const pool = require("../../db");
const { renderContentForChannel } = require("./content-renderer");

const TITLE_MAX = 160;
const BODY_MAX = 20000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function validationError(message) {
    const error = new Error(message);
    error.code = "CONTENT_LIBRARY_VALIDATION";
    return error;
}

function normalizeTitle(value) {
    const title = String(value ?? "").trim();
    if (!title) throw validationError("El título es obligatorio.");
    if (title.length > TITLE_MAX) throw validationError(`El título no puede superar ${TITLE_MAX} caracteres.`);
    return title;
}

function normalizeBody(value) {
    const body = String(value ?? "").trim();
    if (!body) throw validationError("El contenido es obligatorio.");
    if (body.length > BODY_MAX) throw validationError(`El contenido no puede superar ${BODY_MAX} caracteres.`);
    return body;
}

function normalizeId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw validationError("Identificador de contenido inválido.");
    return id;
}

function normalizePagination({ limit, offset } = {}) {
    const parsedLimit = Number(limit ?? DEFAULT_LIMIT);
    const parsedOffset = Number(offset ?? 0);
    return {
        limit: Number.isSafeInteger(parsedLimit) && parsedLimit > 0
            ? Math.min(parsedLimit, MAX_LIMIT)
            : DEFAULT_LIMIT,
        offset: Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0
    };
}

function previewContentAsset(input) {
    const body = normalizeBody(input?.cuerpo);
    return renderContentForChannel(body);
}

function mapAsset(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        titulo: row.titulo,
        cuerpo: row.cuerpo,
        revisionId: Number(row.revision_id),
        revision: Number(row.revision_numero),
        creadoAt: row.creado_at,
        actualizadoAt: row.actualizado_at
    };
}

const SELECT_ASSET = `
    SELECT ci.id, ci.titulo, ci.creado_at, ci.actualizado_at,
           cr.id AS revision_id, cr.numero AS revision_numero, cr.cuerpo
    FROM content_items ci
    JOIN LATERAL (
        SELECT id, numero, cuerpo
        FROM content_revisions
        WHERE content_item_id = ci.id
        ORDER BY numero DESC
        LIMIT 1
    ) cr ON TRUE
`;

async function listContentAssets(options = {}, db = pool) {
    const { limit, offset } = normalizePagination(options);
    const result = await db.query(`
        ${SELECT_ASSET}
        ORDER BY ci.actualizado_at DESC, ci.id DESC
        LIMIT $1 OFFSET $2
    `, [limit, offset]);
    return result.rows.map(mapAsset);
}

async function getContentAsset(rawId, db = pool) {
    const id = normalizeId(rawId);
    const result = await db.query(`${SELECT_ASSET} WHERE ci.id = $1`, [id]);
    return mapAsset(result.rows[0]);
}

async function createContentAsset(input, db = pool) {
    const title = normalizeTitle(input?.titulo);
    const body = normalizeBody(input?.cuerpo);
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const itemResult = await client.query(`
            INSERT INTO content_items (titulo, creado_por)
            VALUES ($1, 'admin')
            RETURNING id, titulo, creado_at, actualizado_at
        `, [title]);
        const item = itemResult.rows[0];
        const revisionResult = await client.query(`
            INSERT INTO content_revisions (content_item_id, numero, cuerpo, creado_por)
            VALUES ($1, 1, $2, 'admin')
            RETURNING id, numero, cuerpo
        `, [item.id, body]);
        const revision = revisionResult.rows[0];
        await client.query(`
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            VALUES ('CONTENT_ITEM', $1, 'CONTENT_ASSET_CREATED', 'admin', $2::jsonb),
                   ('REVISION', $3, 'CONTENT_REVISION_CREATED', 'admin', $4::jsonb)
        `, [item.id, JSON.stringify({ revisionId: revision.id }), revision.id,
            JSON.stringify({ contentItemId: item.id, revision: 1 })]);
        await client.query("COMMIT");
        return mapAsset({
            ...item,
            cuerpo: revision.cuerpo,
            revision_id: revision.id,
            revision_numero: revision.numero
        });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

async function updateContentAsset(rawId, input, db = pool) {
    const id = normalizeId(rawId);
    const title = normalizeTitle(input?.titulo);
    const body = normalizeBody(input?.cuerpo);
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const currentResult = await client.query(`
            ${SELECT_ASSET}
            WHERE ci.id = $1
            FOR UPDATE OF ci
        `, [id]);
        const current = currentResult.rows[0];
        if (!current) {
            await client.query("ROLLBACK");
            return null;
        }

        const titleChanged = current.titulo !== title;
        const bodyChanged = current.cuerpo !== body;
        if (!titleChanged && !bodyChanged) {
            await client.query("COMMIT");
            return mapAsset(current);
        }

        const itemResult = await client.query(`
            UPDATE content_items
            SET titulo = $2, actualizado_at = NOW()
            WHERE id = $1
            RETURNING id, titulo, creado_at, actualizado_at
        `, [id, title]);

        let revision = {
            id: current.revision_id,
            numero: current.revision_numero,
            cuerpo: current.cuerpo
        };
        if (bodyChanged) {
            const revisionResult = await client.query(`
                INSERT INTO content_revisions (content_item_id, numero, cuerpo, creado_por)
                VALUES ($1, $2, $3, 'admin')
                RETURNING id, numero, cuerpo
            `, [id, Number(current.revision_numero) + 1, body]);
            revision = revisionResult.rows[0];
            await client.query(`
                INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
                VALUES ('REVISION', $1, 'CONTENT_REVISION_CREATED', 'admin', $2::jsonb)
            `, [revision.id, JSON.stringify({ contentItemId: id, revision: revision.numero })]);
        }
        await client.query(`
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            VALUES ('CONTENT_ITEM', $1, 'CONTENT_ASSET_UPDATED', 'admin', $2::jsonb)
        `, [id, JSON.stringify({ titleChanged, bodyChanged, revisionId: revision.id })]);
        await client.query("COMMIT");
        return mapAsset({
            ...itemResult.rows[0],
            cuerpo: revision.cuerpo,
            revision_id: revision.id,
            revision_numero: revision.numero
        });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    TITLE_MAX,
    BODY_MAX,
    normalizeTitle,
    normalizeBody,
    normalizeId,
    normalizePagination,
    previewContentAsset,
    listContentAssets,
    getContentAsset,
    createContentAsset,
    updateContentAsset
};
