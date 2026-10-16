"use strict";

const pool = require("../../db");
const contactMemory = require("./commercial-contact-memory");
const { enviarMensaje } = require("./zapi");

const TIME_ZONE = "America/Sao_Paulo";
const MAX_DAILY_LIMIT = 10;
const WORKER_LOCK = "yorda-commercial-outbound-worker";
const SUPPRESSION_SOURCES = new Set(["RECUPERACION", "CAMPAIGN", "REFERRAL", "DIRECTOR", "VIP"]);

function clean(value, max = 500) { return String(value || "").trim().slice(0, max); }

async function enqueue(input, dependencies = {}) {
    const db = dependencies.pool || pool;
    const phone = clean(input?.phone, 40);
    const source = clean(input?.source, 30).toUpperCase();
    const reason = clean(input?.reason, 120);
    const strategy = clean(input?.strategy, 120);
    const content = clean(input?.content, 4000);
    const key = clean(input?.idempotencyKey, 140);
    if (!phone || !reason || !strategy || !content || !key || !["QUOTE_FOLLOWUP", "RECUPERACION", "CAMPAIGN", "REFERRAL", "DIRECTOR", "VIP"].includes(source)) {
        return { queued: false, code: "INVALID_QUEUE_ITEM" };
    }
    if (["CAMPAIGN", "REFERRAL", "DIRECTOR"].includes(source) && input.approved !== true) {
        return { queued: false, code: "APPROVAL_REQUIRED" };
    }
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`commercial-contact:${phone}`]);
        const existing = await client.query("SELECT id,state FROM commercial_outbound_queue WHERE idempotency_key=$1", [key]);
        if (existing.rows[0]) {
            await client.query("COMMIT");
            return { queued: existing.rows[0].state === "PENDING", code: "ALREADY_REGISTERED", id: existing.rows[0].id, state: existing.rows[0].state };
        }
        const customer = await client.query(`SELECT marketing_opt_out, marketing_consent_at, pausa_hasta
            FROM customers WHERE phone=$1 FOR UPDATE`, [phone]);
        if (!customer.rows.length) {
            await client.query("ROLLBACK");
            return { queued: false, code: "CUSTOMER_NOT_FOUND" };
        }
        if (customer.rows[0].marketing_opt_out) {
            await client.query("ROLLBACK");
            return { queued: false, code: "OPTED_OUT" };
        }
        if (SUPPRESSION_SOURCES.has(source) && !customer.rows[0].marketing_consent_at) {
            await client.query("ROLLBACK");
            return { queued: false, code: "NO_VERIFIABLE_MARKETING_CONSENT" };
        }
        if (customer.rows[0].pausa_hasta && new Date(customer.rows[0].pausa_hasta) > new Date()) {
            await client.query("ROLLBACK");
            return { queued: false, code: "HUMAN_PAUSE" };
        }
        const item = await client.query(`INSERT INTO commercial_outbound_queue
            (phone,source,reason,strategy,content,idempotency_key,expires_at,recovery_attempt_id,metadata)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id,state,scheduled_at`,
        [phone, source, reason, strategy, content, key, input.expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000),
            input.recoveryAttemptId || null, JSON.stringify(input.metadata || {})]);
        await client.query("COMMIT");
        return { queued: true, code: "QUEUED", id: item.rows[0].id, state: item.rows[0].state, scheduledAt: item.rows[0].scheduled_at };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        if (error.code === "23505") {
            const current = await db.query("SELECT id,state FROM commercial_outbound_queue WHERE phone=$1 AND state IN ('PENDING','SENDING','UNKNOWN') ORDER BY id DESC LIMIT 1", [phone]).catch(() => ({ rows: [] }));
            return { queued: false, code: "CUSTOMER_ALREADY_QUEUED", id: current.rows[0]?.id || null, state: current.rows[0]?.state || null };
        }
        throw error;
    } finally { client.release(); }
}

async function cancelPendingForPhone(phone, reason = "CLIENT_ACTIVITY", db = pool) {
    if (!phone) return 0;
    const result = await db.query(`WITH cancelled AS (
        UPDATE commercial_outbound_queue SET state='CANCELLED', cancelled_at=NOW(), updated_at=NOW(), error=$2
        WHERE phone=$1 AND state='PENDING' RETURNING recovery_attempt_id
    ), recovery AS (
        UPDATE recuperacion_envios r SET estado='CANCELADO', actualizado_at=NOW(), error=$2
        FROM cancelled c WHERE r.id=c.recovery_attempt_id AND r.estado='EN_COLA'
    ) SELECT COUNT(*)::int AS count FROM cancelled`, [phone, clean(reason, 200)]);
    return Number(result.rows[0]?.count || 0);
}

async function cancelQueuedRow(client, row, reason) {
    await client.query("UPDATE commercial_outbound_queue SET state='CANCELLED',cancelled_at=NOW(),updated_at=NOW(),error=$2 WHERE id=$1 AND state='SENDING'", [row.id, clean(reason, 500)]);
    if (row.recovery_attempt_id) await client.query("UPDATE recuperacion_envios SET estado='CANCELADO',actualizado_at=NOW(),error=$2 WHERE id=$1 AND estado IN ('EN_COLA','ENVIANDO')", [row.recovery_attempt_id, clean(reason, 500)]);
}

async function nextAvailableAt(client, settings) {
    const clock = await client.query(`WITH cfg AS (
            SELECT NOW() AS now_at, NOW() AT TIME ZONE $1 AS local_now,
                   $2::time AS opening, $3::time AS closing, $4::int AS daily_limit
        ), bounds AS (
            SELECT *, ((local_now::date + opening) AT TIME ZONE $1) AS today_open,
                   ((local_now::date + closing) AT TIME ZONE $1) AS today_close,
                   (((local_now::date + 1) + opening) AT TIME ZONE $1) AS tomorrow_open,
                   (local_now::date AT TIME ZONE $1) AS day_start,
                   ((local_now::date + 1) AT TIME ZONE $1) AS day_end
            FROM cfg
        ), sent AS (
            SELECT COUNT(*)::int AS count, MAX(occurred_at) AS last_sent
            FROM commercial_contact_events, bounds
            WHERE provider_status IN ('SENDING','SENT','FAILED','UNKNOWN')
              AND occurred_at>=bounds.day_start AND occurred_at<bounds.day_end
        ) SELECT bounds.*, sent.count AS attempts_today, sent.last_sent AS last_attempt FROM bounds CROSS JOIN sent`,
    [settings.time_zone, settings.opening_time, settings.closing_time, settings.daily_limit]);
    const row = clock.rows[0];
    const now = new Date(row.now_at);
    const opening = new Date(row.today_open);
    const closing = new Date(row.today_close);
    const tomorrow = new Date(row.tomorrow_open);
    if (Number(row.attempts_today) >= Number(settings.daily_limit)) return tomorrow;
    let available = now < opening ? opening : now;
    if (row.last_attempt) {
        const openMinutes = Number(String(settings.opening_time).slice(0, 2)) * 60 + Number(String(settings.opening_time).slice(3, 5));
        const closeMinutes = Number(String(settings.closing_time).slice(0, 2)) * 60 + Number(String(settings.closing_time).slice(3, 5));
        const intervalMinutes = Math.max(1, Math.floor((closeMinutes - openMinutes) / Number(settings.daily_limit)));
        const spaced = new Date(new Date(row.last_attempt).getTime() + intervalMinutes * 60000);
        if (spaced > available) available = spaced;
    }
    if (now >= closing || available >= closing) return tomorrow;
    return available;
}

async function validateQueuedContact(client, row, now = new Date()) {
    const check = await client.query(`SELECT c.marketing_opt_out,c.marketing_consent_at,c.pausa_hasta,c.estado_crm,c.fecha_cotizacion,
        EXISTS(SELECT 1 FROM operations o WHERE o.phone=c.phone AND o.status IN ('pendiente','confirmada')) AS active_operation,
        EXISTS(SELECT 1 FROM bot_inbound_messages bi WHERE bi.phone=c.phone AND bi.recibido_at > NOW() - INTERVAL '24 hours') AS whatsapp_window_open,
        EXISTS(SELECT 1 FROM blocked_numbers b WHERE b.phone=c.phone) AS blocked
        FROM customers c WHERE c.phone=$1`, [row.phone]);
    const customer = check.rows[0];
    if (!customer) return "CUSTOMER_NOT_FOUND";
    if (customer.blocked) return "BLOCKED_NUMBER";
    if (customer.marketing_opt_out) return "OPTED_OUT";
    if (SUPPRESSION_SOURCES.has(row.source) && !customer.marketing_consent_at) return "NO_VERIFIABLE_MARKETING_CONSENT";
    if (customer.pausa_hasta && new Date(customer.pausa_hasta) > now) return "HUMAN_PAUSE";
    if (customer.active_operation) return "ACTIVE_OPERATION";
    // El transporte solo envía texto libre y no tiene un adaptador de plantillas
    // aprobadas. Por tanto, ningún mensaje proactivo de esta cola puede salir
    // fuera de la ventana abierta por un mensaje reciente del cliente.
    if (!customer.whatsapp_window_open) return "WHATSAPP_WINDOW_CLOSED";
    if (row.expires_at && new Date(row.expires_at) <= now) return "EXPIRED";
    if (row.source === "QUOTE_FOLLOWUP") {
        if (!row.metadata?.quoteAt || !customer.fecha_cotizacion || new Date(row.metadata.quoteAt).getTime() !== new Date(customer.fecha_cotizacion).getTime()) return "QUOTE_CHANGED";
        if (customer.estado_crm === "completado") return "QUOTE_ALREADY_COMPLETED";
    }
    if (["CAMPAIGN", "REFERRAL", "DIRECTOR"].includes(row.source) && row.metadata?.approved !== true) return "APPROVAL_REQUIRED";
    if (row.metadata?.campaignId) {
        const campaign = await client.query("SELECT estado FROM director_execution_packages WHERE id=$1", [row.metadata.campaignId]);
        if (campaign.rows[0]?.estado === "BORRADOR") return "WAITING_FOR_APPROVAL_COMMIT";
        if (campaign.rows[0]?.estado !== "APROBADO") return "CAMPAIGN_NO_LONGER_APPROVED";
    }
    if (row.source === "RECUPERACION") {
        const candidate = await require("./recuperacion").obtenerCandidatoRecuperablePorTelefono(row.phone, client);
        if (!candidate) return "RECOVERY_NO_LONGER_ELIGIBLE";
    }
    return null;
}

async function processNext(dependencies = {}) {
    const db = dependencies.pool || pool;
    const send = dependencies.sendFn || enviarMensaje;
    const memory = dependencies.contactMemory || contactMemory;
    const now = dependencies.now ? new Date(dependencies.now) : new Date();
    const client = await db.connect();
    let lockHeld = false;
    let row = null;
    try {
        const lock = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [WORKER_LOCK]);
        lockHeld = lock.rows[0]?.locked === true;
        if (!lockHeld) return { sent: false, code: "WORKER_BUSY" };
        await client.query(`WITH stale AS (
                UPDATE commercial_outbound_queue SET state='UNKNOWN',updated_at=NOW(),error='Proceso interrumpido durante el envío; estado incierto, no se reintentó.'
                WHERE state='SENDING' AND claimed_at < NOW() - INTERVAL '3 minutes' RETURNING recovery_attempt_id
            ) UPDATE recuperacion_envios r SET estado='INCIERTO',actualizado_at=NOW(),error='Resultado del proveedor incierto tras reinicio; no se reintentó.'
              FROM stale WHERE r.id=stale.recovery_attempt_id AND r.estado='ENVIANDO'`);
        const config = await client.query("SELECT * FROM commercial_outbound_settings WHERE id=1");
        const settings = config.rows[0];
        if (!settings || settings.paused) return { sent: false, code: settings?.paused ? "PAUSED" : "NO_SETTINGS" };
        await client.query("BEGIN");
        const due = await client.query(`SELECT * FROM commercial_outbound_queue WHERE state='PENDING' AND scheduled_at<=NOW()
            ORDER BY scheduled_at,id FOR UPDATE SKIP LOCKED LIMIT 1`);
        row = due.rows[0];
        if (!row) { await client.query("COMMIT"); return { sent: false, code: "EMPTY" }; }
        const invalid = await validateQueuedContact(client, row, now);
        if (invalid === "WAITING_FOR_APPROVAL_COMMIT") {
            await client.query("COMMIT");
            return { sent: false, code: "WAITING_FOR_APPROVAL_COMMIT", id: row.id };
        }
        if (invalid) {
            await cancelQueuedRow(client, row, invalid);
            await client.query("COMMIT");
            return { sent: false, code: "CANCELLED", reason: invalid, id: row.id };
        }
        const nextAt = await nextAvailableAt(client, settings);
        if (nextAt > now) {
            await client.query("COMMIT");
            return { sent: false, code: "WAITING_FOR_SLOT", nextAt };
        }
        await client.query(`UPDATE commercial_outbound_queue SET state='SENDING',claimed_at=NOW(),updated_at=NOW() WHERE id=$1`, [row.id]);
        if (row.recovery_attempt_id) await client.query("UPDATE recuperacion_envios SET estado='ENVIANDO',actualizado_at=NOW() WHERE id=$1 AND estado='EN_COLA'", [row.recovery_attempt_id]);
        await client.query("COMMIT");

        const claim = await memory.claim({ phone: row.phone, source: row.source.toLowerCase(), reason: row.reason,
            strategy: row.strategy, content: row.content, metadata: { ...row.metadata, queueId: row.id } }, db);
        if (!claim.allowed) {
            await cancelQueuedRow(client, row, claim.code || "CONTACT_SUPPRESSED");
            return { sent: false, code: "CANCELLED", reason: claim.code, id: row.id };
        }
        await client.query("UPDATE commercial_outbound_queue SET contact_event_id=$2 WHERE id=$1 AND state='SENDING'", [row.id, claim.id]);
        let sent = false;
        let thrown = null;
        try { sent = await send(row.phone, row.content) === true; }
        catch (error) { thrown = error; }
        await memory.settle(claim.id, { sent: sent ? true : null, error: thrown?.message || (!sent ? "Z-API no confirmó el resultado; se considera incierto y no se reintentará automáticamente." : null) }, db);
        const newState = sent ? "SENT" : "UNKNOWN";
        await client.query(`UPDATE commercial_outbound_queue SET state=$2,sent_at=CASE WHEN $2='SENT' THEN NOW() ELSE sent_at END,
            updated_at=NOW(),error=$3 WHERE id=$1 AND state='SENDING'`, [row.id, newState, thrown?.message || (!sent ? "Z-API no confirmó el resultado; no se reintentará." : null)]);
        if (row.recovery_attempt_id) await client.query(`UPDATE recuperacion_envios SET estado=$2,
            enviado_at=CASE WHEN $2='ENVIADO' THEN NOW() ELSE enviado_at END,error=$3,actualizado_at=NOW() WHERE id=$1 AND estado='ENVIANDO'`,
        [row.recovery_attempt_id, sent ? "ENVIADO" : "INCIERTO", thrown?.message || (!sent ? "Z-API no confirmó el resultado; requiere verificación." : null)]);
        await client.query(`UPDATE commercial_outbound_settings SET consecutive_failures=CASE WHEN $1 THEN 0 ELSE consecutive_failures+1 END,
            paused=CASE WHEN $1 THEN paused ELSE consecutive_failures+1>=3 END,updated_at=NOW() WHERE id=1`, [sent]);
        return { sent, code: sent ? "SENT" : "UNKNOWN", id: row.id };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        if (row?.id) {
            await client.query("UPDATE commercial_outbound_queue SET state='UNKNOWN',updated_at=NOW(),error=$2 WHERE id=$1 AND state='SENDING'", [row.id, clean(error.message, 500)]).catch(() => {});
        }
        throw error;
    } finally {
        if (lockHeld) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [WORKER_LOCK]).catch(() => {});
        client.release();
    }
}

async function updateSettings(input, actor = "admin", db = pool) {
    const dailyLimit = Number(input?.dailyLimit);
    const openingTime = clean(input?.openingTime, 5);
    const closingTime = clean(input?.closingTime, 5);
    const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > MAX_DAILY_LIMIT || !timePattern.test(openingTime) || !timePattern.test(closingTime) || openingTime >= closingTime) {
        throw Object.assign(new Error("Configura un límite de 1–10 mensajes y una franja horaria válida."), { code: "COMMERCIAL_QUEUE_VALIDATION" });
    }
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [WORKER_LOCK]);
        const result = await client.query(`UPDATE commercial_outbound_settings SET daily_limit=$1,opening_time=$2::time,closing_time=$3::time,
            updated_at=NOW(),updated_by=$4 WHERE id=1 RETURNING *`, [dailyLimit, openingTime, closingTime, clean(actor, 100)]);
        await client.query("INSERT INTO commercial_outbound_events(event_type,actor,details) VALUES('LIMITS_UPDATED',$1,$2::jsonb)",
            [clean(actor, 100) || "admin", JSON.stringify({ dailyLimit, openingTime, closingTime })]);
        await client.query("COMMIT");
        return result.rows[0];
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { client.release(); }
}

async function setPaused(paused, actor = "admin", db = pool) {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [WORKER_LOCK]);
        const result = await client.query("UPDATE commercial_outbound_settings SET paused=$1,updated_at=NOW(),updated_by=$2 WHERE id=1 RETURNING *", [Boolean(paused), clean(actor, 100)]);
        await client.query("INSERT INTO commercial_outbound_events(event_type,actor,details) VALUES($1,$2,$3::jsonb)",
            [paused ? "QUEUE_PAUSED" : "QUEUE_RESUMED", clean(actor, 100) || "admin", JSON.stringify({ paused: Boolean(paused) })]);
        await client.query("COMMIT");
        return result.rows[0];
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; }
    finally { client.release(); }
}

async function getSnapshot(db = pool, now = new Date()) {
    const [config, states] = await Promise.all([
        db.query("SELECT * FROM commercial_outbound_settings WHERE id=1"),
        db.query(`SELECT COUNT(*) FILTER(WHERE state='PENDING')::int AS pending,
            (SELECT COUNT(*)::int FROM commercial_contact_events e WHERE e.provider_status IN ('SENDING','SENT','FAILED','UNKNOWN')
                AND e.occurred_at >= ((NOW() AT TIME ZONE $1)::date AT TIME ZONE $1)
                AND e.occurred_at < (((NOW() AT TIME ZONE $1)::date + 1) AT TIME ZONE $1)) AS attempts_today,
            (SELECT COUNT(*)::int FROM commercial_contact_events e WHERE e.provider_status = 'SENT'
                AND e.occurred_at >= ((NOW() AT TIME ZONE $1)::date AT TIME ZONE $1)
                AND e.occurred_at < (((NOW() AT TIME ZONE $1)::date + 1) AT TIME ZONE $1)) AS sent_today,
            (SELECT COUNT(*)::int FROM commercial_outbound_queue q WHERE q.state = 'SENT'
                AND q.sent_at >= ((NOW() AT TIME ZONE $1)::date AT TIME ZONE $1)
                AND q.sent_at < (((NOW() AT TIME ZONE $1)::date + 1) AT TIME ZONE $1)) AS queue_sent_today,
            COUNT(*) FILTER(WHERE state='CANCELLED')::int AS cancelled,
            COUNT(*) FILTER(WHERE state IN ('FAILED','UNKNOWN'))::int AS failed,
            MIN(scheduled_at) FILTER(WHERE state='PENDING') AS next_pending
            FROM commercial_outbound_queue`, [TIME_ZONE])
    ]);
    const settings = config.rows[0];
    if (!settings) return { settings: null, counts: states.rows[0], pending: [], nextSendAt: null };
    const nextSendAt = await db.connect().then(async client => {
        try { return await nextAvailableAt(client, settings); } finally { client.release(); }
    });
    const pending = await db.query(`SELECT id,phone,source,reason,state,scheduled_at,expires_at,created_at
        FROM commercial_outbound_queue WHERE state IN ('PENDING','SENDING','UNKNOWN') ORDER BY scheduled_at,id LIMIT 100`);
    return { settings, counts: states.rows[0], pending: pending.rows, nextSendAt, capturedAt: now.toISOString() };
}

module.exports = { TIME_ZONE, MAX_DAILY_LIMIT, enqueue, cancelPendingForPhone, processNext, updateSettings, setPaused, getSnapshot, nextAvailableAt };
