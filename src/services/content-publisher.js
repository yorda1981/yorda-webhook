"use strict";

const pool = require("../../db");
const selectorService = require("./content-selector");
const { renderContentForChannel, CHANNELS } = require("./content-renderer");
const { PUBLICATION_STATES, assertPublicationTransition } = require("./content-center-states");
const outputAdapters = require("./content-output-adapters");

function publicationError(message) {
    const error = new Error(message);
    error.code = "CONTENT_PUBLISHER_VALIDATION";
    return error;
}

function normalizeIdempotencyKey(value) {
    const key = String(value || "").trim();
    if (!key) throw publicationError("La idempotency key es obligatoria.");
    if (key.length > 160) throw publicationError("La idempotency key no puede superar 160 caracteres.");
    return key;
}

function compactError(error) {
    return String(error?.message || error || "El proveedor no confirmó el envío.").slice(0, 1000);
}

function mapPublication(row) {
    if (!row) return null;
    return {
        publicationId: Number(row.id),
        contentId: Number(row.content_item_id),
        revisionId: Number(row.revision_id),
        channel: row.canal,
        destination: row.destino_ref,
        estado: row.estado,
        idempotencyKey: row.idempotency_key,
        publicadaAt: row.publicada_at || null,
        error: row.error || null
    };
}

async function findByIdempotencyKey(key, db = pool) {
    const result = await db.query(`
        SELECT id, content_item_id, revision_id, canal, destino_ref, estado, idempotency_key,
               publicada_at, error
        FROM content_publications
        WHERE idempotency_key = $1
        LIMIT 1
    `, [key]);
    return mapPublication(result.rows[0]);
}

async function preparePublication({ idioma, idempotencyKey, selector, destination }, db) {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const existing = await findByIdempotencyKey(idempotencyKey, client);
        if (existing) {
            await client.query("ROLLBACK");
            return { existing };
        }

        const selected = await selector.selectContent({ idioma }, client);
        if (!selected) {
            await client.query("ROLLBACK");
            return { selected: null };
        }
        const rendered = renderContentForChannel(selected.cuerpo, CHANNELS.WHATSAPP_ADMIN);
        const inserted = await client.query(`
            INSERT INTO content_publications
                (content_item_id, revision_id, canal, destino_ref,
                 cuerpo_renderizado, estado, idempotency_key,
                 programada_para, origen)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 'admin_now')
            RETURNING id, content_item_id, revision_id, canal, destino_ref, estado,
                      idempotency_key, publicada_at, error
        `, [selected.contentId, selected.revisionId, destination.channel,
            destination.reference, rendered.renderedBody,
            PUBLICATION_STATES.SCHEDULED, idempotencyKey]);
        const publication = inserted.rows[0];

        await client.query(`
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            VALUES ('PUBLICATION', $1, 'CONTENT_PUBLICATION_CREATED', 'admin', $2::jsonb)
        `, [publication.id, JSON.stringify({
            contentItemId: selected.contentId,
            revisionId: selected.revisionId,
            channel: destination.channel,
            destination: destination.reference
        })]);

        assertPublicationTransition(PUBLICATION_STATES.SCHEDULED, PUBLICATION_STATES.PUBLISHING);
        await client.query(`
            UPDATE content_publications
            SET estado = $2, iniciada_at = NOW(), actualizado_at = NOW()
            WHERE id = $1 AND estado = $3
        `, [publication.id, PUBLICATION_STATES.PUBLISHING, PUBLICATION_STATES.SCHEDULED]);
        const attempt = await client.query(`
            INSERT INTO content_publication_attempts (publication_id, numero, estado)
            VALUES ($1, 1, 'INICIADO')
            RETURNING id
        `, [publication.id]);
        await client.query(`
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            VALUES ('PUBLICATION', $1, 'CONTENT_PUBLICATION_STARTED', 'system', $2::jsonb),
                   ('ATTEMPT', $3, 'CONTENT_ATTEMPT_STARTED', 'system', $4::jsonb)
        `, [publication.id, JSON.stringify({ attemptId: attempt.rows[0].id }),
            attempt.rows[0].id, JSON.stringify({ publicationId: publication.id, attempt: 1 })]);
        await client.query("COMMIT");
        return {
            publication: { ...mapPublication(publication), estado: PUBLICATION_STATES.PUBLISHING },
            selected,
            rendered,
            attemptId: Number(attempt.rows[0].id)
        };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

async function finishPublication({ publicationId, success, errorMessage }, db) {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const currentResult = await client.query(`
            SELECT cp.id, cp.content_item_id, cp.revision_id, cp.canal, cp.destino_ref, cp.estado,
                   cp.idempotency_key, cp.publicada_at, cp.error,
                   cpa.id AS attempt_id
            FROM content_publications cp
            JOIN content_publication_attempts cpa
              ON cpa.publication_id = cp.id AND cpa.numero = 1
            WHERE cp.id = $1
            FOR UPDATE OF cp, cpa
        `, [publicationId]);
        const current = currentResult.rows[0];
        if (!current) throw new Error("Publicación o intento no encontrado al finalizar.");
        assertPublicationTransition(
            current.estado,
            success ? PUBLICATION_STATES.PUBLISHED : PUBLICATION_STATES.FAILED
        );

        let publishedAt = current.publicada_at || null;
        if (success) {
            const publishedResult = await client.query(`
                UPDATE content_publications
                SET estado = $2, publicada_at = NOW(), error = NULL, actualizado_at = NOW()
                WHERE id = $1
                RETURNING publicada_at
            `, [publicationId, PUBLICATION_STATES.PUBLISHED]);
            publishedAt = publishedResult.rows[0]?.publicada_at || publishedAt;
            await client.query(`
                UPDATE content_publication_attempts
                SET estado = 'ENVIADO', finalizado_at = NOW(), error = NULL
                WHERE id = $1
            `, [current.attempt_id]);
            await client.query(`
                UPDATE content_items
                SET ultima_utilizacion_at = NOW(), actualizado_at = NOW()
                WHERE id = $1
            `, [current.content_item_id]);
            await client.query(`
                INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
                VALUES ('ATTEMPT', $1, 'CONTENT_ATTEMPT_SENT', 'system', $2::jsonb),
                       ('PUBLICATION', $3, 'CONTENT_PUBLICATION_PUBLISHED', 'system', $4::jsonb),
                       ('CONTENT_ITEM', $5, 'CONTENT_ASSET_USED', 'system', $6::jsonb)
            `, [current.attempt_id, JSON.stringify({ publicationId }),
                publicationId, JSON.stringify({ contentItemId: current.content_item_id, revisionId: current.revision_id }),
                current.content_item_id, JSON.stringify({ publicationId, revisionId: current.revision_id })]);
        } else {
            const safeError = compactError(errorMessage);
            await client.query(`
                UPDATE content_publications
                SET estado = $2, error = $3, actualizado_at = NOW()
                WHERE id = $1
            `, [publicationId, PUBLICATION_STATES.FAILED, safeError]);
            await client.query(`
                UPDATE content_publication_attempts
                SET estado = 'FALLIDO', finalizado_at = NOW(), error = $2
                WHERE id = $1
            `, [current.attempt_id, safeError]);
            await client.query(`
                INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
                VALUES ('ATTEMPT', $1, 'CONTENT_ATTEMPT_FAILED', 'system', $2::jsonb),
                       ('PUBLICATION', $3, 'CONTENT_PUBLICATION_FAILED', 'system', $4::jsonb)
            `, [current.attempt_id, JSON.stringify({ publicationId, error: safeError }),
                publicationId, JSON.stringify({ error: safeError })]);
        }
        await client.query("COMMIT");
        return {
            ...mapPublication(current),
            estado: success ? PUBLICATION_STATES.PUBLISHED : PUBLICATION_STATES.FAILED,
            publicadaAt: success ? publishedAt : null,
            error: success ? null : compactError(errorMessage)
        };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

async function markAmbiguous(publicationId, reason, db) {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const current = await client.query(`
            SELECT cp.id, cp.estado, cpa.id AS attempt_id
            FROM content_publications cp
            JOIN content_publication_attempts cpa
              ON cpa.publication_id = cp.id AND cpa.numero = 1
            WHERE cp.id = $1
            FOR UPDATE OF cp, cpa
        `, [publicationId]);
        if (!current.rows[0]) throw new Error("Publicación no encontrada.");
        if (current.rows[0].estado === PUBLICATION_STATES.PUBLISHED) {
            await client.query("COMMIT");
            return PUBLICATION_STATES.PUBLISHED;
        }
        if (current.rows[0].estado !== PUBLICATION_STATES.PUBLISHING) {
            await client.query("COMMIT");
            return current.rows[0].estado;
        }
        assertPublicationTransition(PUBLICATION_STATES.PUBLISHING, PUBLICATION_STATES.AMBIGUOUS);
        const safeError = compactError(reason);
        await client.query(`UPDATE content_publications SET estado = $2, error = $3, actualizado_at = NOW() WHERE id = $1`,
            [publicationId, PUBLICATION_STATES.AMBIGUOUS, safeError]);
        await client.query(`UPDATE content_publication_attempts SET estado = 'AMBIGUO', error = $2, finalizado_at = NOW() WHERE id = $1`,
            [current.rows[0].attempt_id, safeError]);
        await client.query(`
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            VALUES ('ATTEMPT', $1, 'CONTENT_ATTEMPT_AMBIGUOUS', 'system', $2::jsonb),
                   ('PUBLICATION', $3, 'CONTENT_PUBLICATION_AMBIGUOUS', 'system', $4::jsonb)
        `, [current.rows[0].attempt_id, JSON.stringify({ publicationId, error: safeError }),
            publicationId, JSON.stringify({ error: safeError })]);
        await client.query("COMMIT");
        return PUBLICATION_STATES.AMBIGUOUS;
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

async function publishSelectedContent(input, dependencies = {}) {
    const db = dependencies.pool || pool;
    const selector = dependencies.selector || selectorService;
    const resolveDestinationFn = dependencies.resolveDestinationFn || outputAdapters.resolveOutputDestination;
    const sendDestinationFn = dependencies.sendDestinationFn || outputAdapters.sendToDestination;
    const prepareFn = dependencies.prepareFn || preparePublication;
    const finishFn = dependencies.finishFn || finishPublication;
    const ambiguousFn = dependencies.ambiguousFn || markAmbiguous;
    const findFn = dependencies.findFn || findByIdempotencyKey;
    const idempotencyKey = normalizeIdempotencyKey(input?.idempotencyKey);
    const idioma = selector.normalizeLanguage(input?.idioma);
    const destination = await resolveDestinationFn(input, dependencies);
    if (!destination) return { ok: false, code: "DESTINATION_NOT_FOUND", error: "Destino no encontrado o inactivo." };

    let prepared;
    try {
        prepared = await prepareFn({ idioma, idempotencyKey, selector, destination }, db);
    } catch (error) {
        if (error.code === "23505") {
            const existing = await findFn(idempotencyKey, db);
            return { ok: existing?.estado === PUBLICATION_STATES.PUBLISHED, code: "ALREADY_REGISTERED", publication: existing };
        }
        throw error;
    }
    if (prepared.existing) {
        return {
            ok: prepared.existing.estado === PUBLICATION_STATES.PUBLISHED,
            code: "ALREADY_REGISTERED",
            publication: prepared.existing
        };
    }
    if (!prepared.selected) return { ok: false, code: "NO_ELIGIBLE_CONTENT" };

    let sent = false;
    let sendError = null;
    try {
        sent = await sendDestinationFn(destination, prepared.rendered.renderedBody, dependencies);
        if (!sent) sendError = new Error("El proveedor no confirmó el envío.");
    } catch (error) {
        sendError = error;
    }

    try {
        const publication = await finishFn({
            publicationId: prepared.publication.publicationId,
            success: sent,
            errorMessage: sendError
        }, db);
        return {
            ok: sent,
            code: sent ? "PUBLISHED" : "SEND_FAILED",
            selected: prepared.selected,
            rendered: prepared.rendered,
            publication
        };
    } catch (finalizeError) {
        try {
            const resolvedState = await ambiguousFn(prepared.publication.publicationId, finalizeError, db);
            if (resolvedState === PUBLICATION_STATES.PUBLISHED) {
                const publication = await findFn(idempotencyKey, db);
                return { ok: true, code: "PUBLISHED", selected: prepared.selected, rendered: prepared.rendered, publication };
            }
        } catch (_) {}
        return {
            ok: false,
            code: "AMBIGUOUS_RESULT",
            error: "El envío pudo completarse, pero su estado final requiere revisión.",
            publication: prepared.publication
        };
    }
}

module.exports = {
    normalizeIdempotencyKey,
    findByIdempotencyKey,
    preparePublication,
    finishPublication,
    markAmbiguous,
    publishSelectedContent
};
