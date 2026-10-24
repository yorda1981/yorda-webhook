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
        estado: row.estado || "ACTIVO",
        origen: row.origen || "operador",
        origenSistema: row.origen_sistema || null,
        grupo: row.grupo || null,
        categoria: row.categoria || null,
        aporte: row.aporte || null,
        impacto: row.impacto || null,
        fuentes: Array.isArray(row.fuentes) ? row.fuentes : [],
        creadoAt: row.creado_at,
        actualizadoAt: row.actualizado_at
    };
}

const SELECT_ASSET = `
    SELECT ci.id, ci.titulo, ci.creado_at, ci.actualizado_at,
           ci.estado, ci.origen, ci.origen_sistema, ci.grupo, ci.categoria, ci.aporte, ci.impacto, ci.fuentes,
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

const DRAFT_ACTIONS = Object.freeze({
    approve: { estado: "ACTIVO", evento: "CONTENT_ASSET_APPROVED" },
    discard: { estado: "INACTIVO", evento: "CONTENT_ASSET_DISCARDED" }
});

function normalizeSources(fuentes) {
    if (!Array.isArray(fuentes) || !fuentes.length) throw validationError("Un borrador del Director necesita al menos una fuente.");
    return fuentes.map(fuente => ({
        nombre: String(fuente?.nombre || "").slice(0, 80),
        titulo: String(fuente?.titulo || "").slice(0, 300),
        url: String(fuente?.url || "").slice(0, 1000),
        publicadoAt: fuente?.publicadoAt || null,
        ...(fuente?.datosVerificados && typeof fuente.datosVerificados === "object"
            ? { datosVerificados: fuente.datosVerificados }
            : {})
    }));
}

// Borrador escrito por el Director IA: queda en BORRADOR, fuera del alcance
// del selector automático, hasta que el operador lo apruebe.
async function createDirectorDraft(input, db = pool) {
    const title = normalizeTitle(input?.titulo);
    const body = normalizeBody(input?.cuerpo);
    const categoria = String(input?.categoria || "").slice(0, 40) || null;
    const grupo = ["actualidad", "permanente", "comercial"].includes(input?.grupo) ? input.grupo : null;
    if (!grupo) throw validationError("Un borrador del Director debe ser de actualidad, permanente o comercial.");
    const aporte = String(input?.aporte || "").trim().slice(0, 600);
    if (aporte.length < 20) throw validationError("Un borrador del Director debe explicar cómo genera confianza, clientes o remesas.");
    const fuentes = normalizeSources(input?.fuentes);
    const impacto = input?.impacto && typeof input.impacto === "object" ? input.impacto : null;
    const origenSistema = input?.origenSistema ? String(input.origenSistema).slice(0, 40) : null;
    if (origenSistema) {
        const existing = await db.query(`${SELECT_ASSET} WHERE ci.origen_sistema = $1`, [origenSistema]);
        if (existing.rows[0]) return mapAsset(existing.rows[0]);
    }
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const itemResult = await client.query(`
            INSERT INTO content_items (titulo, creado_por, estado, origen, grupo, categoria, aporte, impacto, fuentes, origen_sistema)
            VALUES ($1, 'director', 'BORRADOR', 'director', $2, $3, $4, $5::jsonb, $6::jsonb, $7)
            RETURNING id, titulo, creado_at, actualizado_at, estado, origen, grupo, categoria, aporte, impacto, fuentes
        `, [title, grupo, categoria, aporte, impacto ? JSON.stringify(impacto) : null, JSON.stringify(fuentes), origenSistema]);
        const item = itemResult.rows[0];
        const revisionResult = await client.query(`
            INSERT INTO content_revisions (content_item_id, numero, cuerpo, creado_por)
            VALUES ($1, 1, $2, 'director')
            RETURNING id, numero, cuerpo
        `, [item.id, body]);
        const revision = revisionResult.rows[0];
        await client.query(`
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            VALUES ('CONTENT_ITEM', $1, 'CONTENT_ASSET_CREATED', 'director', $2::jsonb),
                   ('REVISION', $3, 'CONTENT_REVISION_CREATED', 'director', $4::jsonb)
        `, [item.id, JSON.stringify({ revisionId: revision.id, origen: "director", grupo, categoria, fuentes: fuentes.map(f => f.url) }),
            revision.id, JSON.stringify({ contentItemId: item.id, revision: 1 })]);
        await client.query("COMMIT");
        return mapAsset({ ...item, cuerpo: revision.cuerpo, revision_id: revision.id, revision_numero: revision.numero });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        if (error.code === "23505" && origenSistema) {
            const existing = await db.query(`${SELECT_ASSET} WHERE ci.origen_sistema = $1`, [origenSistema]);
            if (existing.rows[0]) return mapAsset(existing.rows[0]);
        }
        throw error;
    } finally {
        client.release();
    }
}

// Aprobar (BORRADOR → ACTIVO) o descartar (BORRADOR → INACTIVO) un borrador.
async function resolveDraft(rawId, action, db = pool, actor = "admin") {
    const id = normalizeId(rawId);
    const target = DRAFT_ACTIONS[action];
    if (!target) throw validationError("Acción de borrador inválida.");
    const result = await db.query(`
        WITH updated AS (
            UPDATE content_items SET estado = $2, actualizado_at = NOW()
            WHERE id = $1 AND estado = 'BORRADOR'
            RETURNING id
        ), event AS (
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            SELECT 'CONTENT_ITEM', id, $3, $4, '{}'::jsonb FROM updated
        )
        SELECT id FROM updated
    `, [id, target.estado, actor === "marketer_policy" && action === "approve" ? "CONTENT_ASSET_AUTO_APPROVED" : target.evento, actor]);
    const asset = await getContentAsset(id, db);
    return { asset, changed: Boolean(result.rows[0]) };
}

async function requireManualReview(rawId, db = pool) {
    const id = normalizeId(rawId);
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const item = await client.query("SELECT id,estado,grupo FROM content_items WHERE id=$1 FOR UPDATE", [id]);
        const row = item.rows[0];
        if (!row) { await client.query("ROLLBACK"); return { asset: null, changed: false }; }
        if (row.grupo !== "comercial") throw validationError("La revisión manual adicional solo aplica a contenido comercial automático.");
        if (row.estado !== "ACTIVO") throw Object.assign(validationError("Solo se puede solicitar revisión manual antes de la publicación y desde un contenido activo."), { status: 409 });
        const inFlight = await client.query(`SELECT 1 FROM content_schedules cs
            WHERE cs.content_item_id=$1 AND cs.estado IN ('EJECUTANDO','EJECUTADA')
            UNION ALL SELECT 1 FROM content_publications cp WHERE cp.content_item_id=$1 AND cp.estado IN ('PUBLICANDO','AMBIGUA','PUBLICADA')
            LIMIT 1`, [id]);
        if (inFlight.rows.length) throw Object.assign(validationError("La publicación ya se está enviando, es incierta o se publicó; no se puede retener."), { status: 409 });
        const canceled = await client.query(`UPDATE content_schedules SET estado='CANCELADA',cancelada_at=NOW(),
            actualizado_at=NOW(),error='El operador solicitó revisión manual.',result_code='MANUAL_REVIEW_REQUIRED'
            WHERE content_item_id=$1 AND estado='PENDIENTE' RETURNING id`, [id]);
        await client.query(`UPDATE content_items SET estado='BORRADOR',actualizado_at=NOW() WHERE id=$1`, [id]);
        await client.query(`INSERT INTO content_events (entity_type,entity_id,event_type,actor,datos)
            VALUES ('CONTENT_ITEM',$1,'CONTENT_MARKETER_MANUAL_REVIEW_REQUIRED','admin',$2::jsonb)`,
        [id, JSON.stringify({ canceledScheduleIds: canceled.rows.map(value => Number(value.id)) })]);
        for (const schedule of canceled.rows) {
            await client.query(`INSERT INTO content_events (entity_type,entity_id,event_type,actor,datos)
                VALUES ('SCHEDULE',$1,'CONTENT_MARKETER_SCHEDULE_CANCELED','admin','{"reason":"MANUAL_REVIEW_REQUIRED"}'::jsonb)`, [schedule.id]);
        }
        await client.query("COMMIT");
        return { asset: await getContentAsset(id, db), changed: true };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally { client.release(); }
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
    updateContentAsset,
    createDirectorDraft,
    resolveDraft,
    requireManualReview
};
