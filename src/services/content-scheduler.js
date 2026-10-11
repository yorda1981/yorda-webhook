"use strict";

const pool = require("../../db");
const contentPublisher = require("./content-publisher");
const contentSelector = require("./content-selector");

const SCHEDULE_STATES = Object.freeze({
    PENDING: "PENDIENTE",
    RUNNING: "EJECUTANDO",
    EXECUTED: "EJECUTADA",
    FAILED: "FALLIDA",
    AMBIGUOUS: "AMBIGUA",
    CANCELED: "CANCELADA"
});

const CLAIM_LEASE_MINUTES = 5;
const POLL_INTERVAL_MS = 30 * 1000;

function schedulerValidationError(message) {
    const error = new Error(message);
    error.code = "CONTENT_SCHEDULER_VALIDATION";
    return error;
}

function normalizeScheduleId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw schedulerValidationError("Identificador de programación inválido.");
    return id;
}

function normalizeScheduledAt(value, now = new Date()) {
    const raw = String(value || "").trim();
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
        throw schedulerValidationError("La fecha debe incluir zona horaria u offset UTC.");
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) throw schedulerValidationError("Fecha de programación inválida.");
    if (date.getTime() <= now.getTime()) throw schedulerValidationError("La fecha de programación debe estar en el futuro.");
    return date;
}

function optionalNumber(value) {
    return value === null || value === undefined ? null : Number(value);
}

function mapSchedule(row) {
    if (!row) return null;
    return {
        scheduleId: Number(row.id),
        idioma: row.idioma,
        programadaPara: row.programada_para,
        estado: row.estado,
        idempotencyKey: row.idempotency_key,
        contentId: optionalNumber(row.content_item_id),
        publicationId: optionalNumber(row.publication_id),
        resultCode: row.result_code || null,
        error: row.error || null,
        claimedAt: row.claimed_at || null,
        ejecutadaAt: row.ejecutada_at || null,
        canceladaAt: row.cancelada_at || null
    };
}

async function findScheduleByKey(key, db = pool) {
    const result = await db.query(`
        SELECT * FROM content_schedules WHERE idempotency_key = $1 LIMIT 1
    `, [key]);
    return mapSchedule(result.rows[0]);
}

async function schedulePublication(input, dependencies = {}) {
    const db = dependencies.pool || pool;
    const language = contentSelector.normalizeLanguage(input?.idioma);
    const idempotencyKey = contentPublisher.normalizeIdempotencyKey(input?.idempotencyKey);
    const scheduledAt = normalizeScheduledAt(input?.programadaPara, dependencies.now || new Date());
    const contentId = contentSelector.normalizeContentId(input?.contentId);
    try {
        const result = await db.query(`
            WITH inserted AS (
                INSERT INTO content_schedules
                    (idioma, programada_para, estado, idempotency_key, content_item_id)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING *
            ), event AS (
                INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
                SELECT 'SCHEDULE', id, 'CONTENT_SCHEDULE_CREATED', 'admin',
                       jsonb_build_object('programadaPara', programada_para, 'idioma', idioma,
                                          'contentItemId', content_item_id)
                FROM inserted
            )
            SELECT *, true AS nueva FROM inserted
        `, [language, scheduledAt.toISOString(), SCHEDULE_STATES.PENDING, idempotencyKey, contentId]);
        if (result.rows[0]) return { schedule: mapSchedule(result.rows[0]), alreadyExisted: false };
        return { schedule: await findScheduleByKey(idempotencyKey, db), alreadyExisted: true };
    } catch (error) {
        if (error.code === "23503") throw schedulerValidationError("El contenido indicado no existe.");
        throw error;
    }
}

async function cancelSchedule(rawId, db = pool) {
    const id = normalizeScheduleId(rawId);
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query(`
            UPDATE content_schedules
            SET estado = $2, cancelada_at = NOW(), actualizado_at = NOW()
            WHERE id = $1 AND estado = $3
            RETURNING *
        `, [id, SCHEDULE_STATES.CANCELED, SCHEDULE_STATES.PENDING]);
        if (!result.rows[0]) {
            const current = await client.query("SELECT * FROM content_schedules WHERE id = $1", [id]);
            await client.query("ROLLBACK");
            return { canceled: false, schedule: mapSchedule(current.rows[0]) };
        }
        await client.query(`
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            VALUES ('SCHEDULE', $1, 'CONTENT_SCHEDULE_CANCELED', 'admin', '{}'::jsonb)
        `, [id]);
        await client.query("COMMIT");
        return { canceled: true, schedule: mapSchedule(result.rows[0]) };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

async function recoverAbandonedSchedules(db = pool) {
    const result = await db.query(`
        WITH recovered AS (
            UPDATE content_schedules
            SET estado = $1, claimed_at = NULL, actualizado_at = NOW(),
                error = 'Claim recuperado después de reinicio o interrupción.'
            WHERE estado = $2
              AND claimed_at < NOW() - INTERVAL '${CLAIM_LEASE_MINUTES} minutes'
            RETURNING id
        ), events AS (
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            SELECT 'SCHEDULE', id, 'CONTENT_SCHEDULE_RECOVERED', 'system',
                   jsonb_build_object('leaseMinutes', ${CLAIM_LEASE_MINUTES})
            FROM recovered
        )
        SELECT id FROM recovered
    `, [SCHEDULE_STATES.PENDING, SCHEDULE_STATES.RUNNING]);
    return result.rows.length;
}

async function claimDueSchedules({ limit = 10 } = {}, db = pool) {
    const safeLimit = Number.isSafeInteger(Number(limit))
        ? Math.max(1, Math.min(Number(limit), 50))
        : 10;
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query(`
            WITH due AS (
                SELECT id
                FROM content_schedules
                WHERE estado = $1 AND programada_para <= NOW()
                ORDER BY programada_para ASC, id ASC
                FOR UPDATE SKIP LOCKED
                LIMIT $2
            ), claimed AS (
                UPDATE content_schedules cs
                SET estado = $3, claimed_at = NOW(), actualizado_at = NOW(), error = NULL
                FROM due
                WHERE cs.id = due.id
                RETURNING cs.*
            ), events AS (
                INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
                SELECT 'SCHEDULE', id, 'CONTENT_SCHEDULE_CLAIMED', 'system',
                       jsonb_build_object('claimedAt', claimed_at)
                FROM claimed
            )
            SELECT * FROM claimed ORDER BY programada_para ASC, id ASC
        `, [SCHEDULE_STATES.PENDING, safeLimit, SCHEDULE_STATES.RUNNING]);
        await client.query("COMMIT");
        return result.rows.map(mapSchedule);
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

function outcomeForPublisherResult(result) {
    if (result?.code === "PUBLISHED") return SCHEDULE_STATES.EXECUTED;
    if (result?.code === "ALREADY_REGISTERED" && result.publication?.estado === "PUBLICADA") {
        return SCHEDULE_STATES.EXECUTED;
    }
    if (result?.code === "AMBIGUOUS_RESULT" ||
        (result?.code === "ALREADY_REGISTERED" && ["PUBLICANDO", "AMBIGUA"].includes(result.publication?.estado))) {
        return SCHEDULE_STATES.AMBIGUOUS;
    }
    return SCHEDULE_STATES.FAILED;
}

async function finishSchedule(schedule, publisherResult, db = pool) {
    const targetState = outcomeForPublisherResult(publisherResult);
    const publication = publisherResult?.publication || null;
    const error = String(publisherResult?.error || "").slice(0, 1000) || null;
    const eventType = targetState === SCHEDULE_STATES.EXECUTED
        ? "CONTENT_SCHEDULE_EXECUTED"
        : targetState === SCHEDULE_STATES.AMBIGUOUS
            ? "CONTENT_SCHEDULE_AMBIGUOUS"
            : "CONTENT_SCHEDULE_FAILED";
    const result = await db.query(`
        WITH finished AS (
            UPDATE content_schedules
            SET estado = $2,
                ejecutada_at = NOW(),
                publication_id = $3,
                result_code = $4,
                error = $5,
                actualizado_at = NOW()
            WHERE id = $1 AND estado = $6
            RETURNING *
        ), event AS (
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            SELECT 'SCHEDULE', id, $7, 'system',
                   jsonb_build_object('resultCode', result_code, 'publicationId', publication_id)
            FROM finished
        )
        SELECT * FROM finished
    `, [schedule.scheduleId, targetState, publication?.publicationId || null,
        publisherResult?.code || "UNEXPECTED_ERROR", error,
        SCHEDULE_STATES.RUNNING, eventType]);
    return mapSchedule(result.rows[0]);
}

async function executeClaimedSchedule(schedule, dependencies = {}) {
    const db = dependencies.pool || pool;
    const publisher = dependencies.publisher || contentPublisher;
    const finishFn = dependencies.finishFn || finishSchedule;
    let result;
    try {
        const input = { idioma: schedule.idioma, idempotencyKey: schedule.idempotencyKey };
        if (schedule.contentId) input.contentId = schedule.contentId;
        result = await publisher.publishSelectedContent(input);
    } catch (error) {
        result = { ok: false, code: "UNEXPECTED_ERROR", error: error.message };
    }
    return finishFn(schedule, result, db);
}

async function runDueSchedulesOnce(dependencies = {}) {
    const db = dependencies.pool || pool;
    const claimed = await claimDueSchedules({ limit: dependencies.limit || 10 }, db);
    const results = [];
    for (const schedule of claimed) {
        results.push(await executeClaimedSchedule(schedule, dependencies));
    }
    return results;
}

function startPersistentScheduler(dependencies = {}) {
    const db = dependencies.pool || pool;
    const intervalMs = dependencies.intervalMs || POLL_INTERVAL_MS;
    const recoverFn = dependencies.recoverFn || recoverAbandonedSchedules;
    const runFn = dependencies.runFn || runDueSchedulesOnce;
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await recoverFn(db);
            await runFn({ ...dependencies, pool: db });
        } catch (error) {
            console.error("❌ Content Scheduler:", error.message);
        } finally {
            running = false;
        }
    };
    const ready = tick();
    const timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return { ready, stop: () => clearInterval(timer), tick };
}

module.exports = {
    SCHEDULE_STATES,
    CLAIM_LEASE_MINUTES,
    POLL_INTERVAL_MS,
    normalizeScheduleId,
    normalizeScheduledAt,
    findScheduleByKey,
    schedulePublication,
    cancelSchedule,
    recoverAbandonedSchedules,
    claimDueSchedules,
    outcomeForPublisherResult,
    finishSchedule,
    executeClaimedSchedule,
    runDueSchedulesOnce,
    startPersistentScheduler
};
