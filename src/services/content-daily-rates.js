"use strict";

const pool = require("../../db");
const { ZONA_NEGOCIO } = require("../utils/timezone");

const RATE_ITEM_KEY = "daily-remittance-rates";
// Conserva el horario del flujo administrativo previo (13:15 UTC = 10:15 en
// São Paulo) usando la cola persistente que ya procesa el grupo.
const ADMIN_SEND_TIME = "10:15";

function settingsError(message) {
    const error = new Error(message);
    error.code = "CONTENT_DAILY_RATES_VALIDATION";
    return error;
}

function localParts(date, timeZone = ZONA_NEGOCIO) {
    const values = {};
    for (const part of new Intl.DateTimeFormat("en-CA", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(date)) values[part.type] = part.value;
    return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

function formatRate(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Las tasas vigentes están incompletas o no son válidas.");
    return new Intl.NumberFormat("es", { maximumFractionDigits: 2 }).format(amount);
}

function renderDailyRates(rates) {
    if (!rates) throw new Error("No hay tasas vigentes disponibles en la base de datos.");
    const updated = rates.updated_at ? new Date(rates.updated_at) : null;
    if (!updated || Number.isNaN(updated.getTime())) throw new Error("La fecha de actualización de las tasas no es válida.");
    const updatedLabel = new Intl.DateTimeFormat("es", {
        dateStyle: "medium", timeStyle: "short", timeZone: ZONA_NEGOCIO
    }).format(updated);
    return [
        "*Tasas vigentes de YORDA*",
        "",
        `🇧🇷 R$ 1 = CUP ${formatRate(rates.brl_0)} para envíos menores de R$ 100`,
        `🇧🇷 R$ 1 = CUP ${formatRate(rates.brl_100)} para envíos de R$ 100 a R$ 499`,
        `🇧🇷 R$ 1 = CUP ${formatRate(rates.brl_500)} para envíos de R$ 500 a R$ 999`,
        `🇧🇷 R$ 1 = CUP ${formatRate(rates.brl_1000)} para envíos desde R$ 1.000`,
        `💵 USD a tarjeta: R$ 1 = USD ${formatRate(rates.usd1)}`,
        `💳 USD prepago: R$ 1 = USD ${formatRate(rates.usd2)}`,
        `🪙 MLC: R$ 1 = MLC ${formatRate(rates.mlc)}`,
        `🏠 Efectivo en CUP: R$ 1 = CUP ${formatRate(rates.efectivo)}`,
        "",
        `Actualizadas: ${updatedLabel}`,
        "",
        "¿Quieres enviar a tu familia? Escríbele al bot de YORDA por privado para recibir una cotización con la tasa vigente y comenzar tu remesa."
    ].join("\n");
}

function minutesOfDay(value) {
    const match = String(value || "").match(/^(\d{2}):(\d{2})/);
    if (!match) throw settingsError("La hora de publicación de tasas no es válida.");
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) throw settingsError("La hora de publicación de tasas no es válida.");
    return hours * 60 + minutes;
}

async function getDailyRatesSettings(db = pool) {
    const result = await db.query(`
        SELECT id, nombre, tasas_habilitadas, to_char(tasas_hora, 'HH24:MI') AS tasas_hora
        FROM content_destinations WHERE activo = TRUE ORDER BY id LIMIT 1
    `);
    const row = result.rows[0];
    return row ? {
        destinationId: Number(row.id), destinationName: row.nombre,
        enabled: row.tasas_habilitadas, time: row.tasas_hora,
        timeZone: ZONA_NEGOCIO
    } : null;
}

async function updateDailyRatesSettings(input, db = pool) {
    if (typeof input?.enabled !== "boolean") throw settingsError("Indica si la publicación automática está habilitada.");
    const time = String(input?.time || "");
    minutesOfDay(time);
    const result = await db.query(`
        UPDATE content_destinations
        SET tasas_habilitadas = $2, tasas_hora = $3::time, actualizado_at = NOW()
        WHERE id = (SELECT id FROM content_destinations WHERE activo = TRUE ORDER BY id LIMIT 1)
        RETURNING id, nombre, tasas_habilitadas, to_char(tasas_hora, 'HH24:MI') AS tasas_hora
    `, [input.enabled, time]);
    if (!result.rows[0]) throw settingsError("No hay un grupo activo configurado.");
    return {
        destinationId: Number(result.rows[0].id), destinationName: result.rows[0].nombre,
        enabled: result.rows[0].tasas_habilitadas, time: result.rows[0].tasas_hora,
        timeZone: ZONA_NEGOCIO
    };
}

async function ensureDailyRatesContent(client, body) {
    const found = await client.query(`
        SELECT id FROM content_items WHERE origen_sistema = $1 FOR UPDATE
    `, [RATE_ITEM_KEY]);
    let contentId;
    if (found.rows[0]) {
        contentId = Number(found.rows[0].id);
        const latest = await client.query(`
            SELECT numero, cuerpo FROM content_revisions
            WHERE content_item_id = $1 ORDER BY numero DESC LIMIT 1
        `, [contentId]);
        if (latest.rows[0]?.cuerpo === body) return contentId;
        await client.query(`UPDATE content_items SET actualizado_at = NOW(), estado = 'ACTIVO' WHERE id = $1`, [contentId]);
        await client.query(`
            INSERT INTO content_revisions (content_item_id, numero, cuerpo, creado_por)
            VALUES ($1, $2, $3, 'system')
        `, [contentId, Number(latest.rows[0]?.numero || 0) + 1, body]);
    } else {
        const inserted = await client.query(`
            INSERT INTO content_items (titulo, creado_por, estado, idioma, prioridad, origen, origen_sistema)
            VALUES ('Tasas vigentes · publicación diaria', 'system', 'ACTIVO', 'es', 100, 'system', $1)
            RETURNING id
        `, [RATE_ITEM_KEY]);
        contentId = Number(inserted.rows[0].id);
        await client.query(`
            INSERT INTO content_revisions (content_item_id, numero, cuerpo, creado_por)
            VALUES ($1, 1, $2, 'system')
        `, [contentId, body]);
    }
    return contentId;
}

// Crea una sola programación diaria en la cola ya existente. Si un reinicio o
// demora del scheduler ocurre después de la hora prevista, encola la publicación
// vencida para recuperarla el mismo día. La clave por fecha impide duplicados.
async function ensureDailyRatesSchedule({ db = pool, now = new Date() } = {}) {
    const config = await getDailyRatesSettings(db);
    if (!config?.enabled) return { status: config ? "DISABLED" : "NO_DESTINATION" };
    const local = localParts(now, config.timeZone);
    const targetMinutes = minutesOfDay(config.time);
    const nowMinutes = Number(local.time.slice(0, 2)) * 60 + Number(local.time.slice(3, 5));
    if (nowMinutes < targetMinutes) return { status: "NOT_DUE" };
    const key = `daily-rates-${local.date}`;
    const existing = await db.query("SELECT id, estado FROM content_schedules WHERE idempotency_key = $1 LIMIT 1", [key]);
    if (existing.rows[0]) return { status: "ALREADY_SCHEDULED", scheduleId: Number(existing.rows[0].id), state: existing.rows[0].estado };

    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
        const raced = await client.query("SELECT id, estado FROM content_schedules WHERE idempotency_key = $1 LIMIT 1", [key]);
        if (raced.rows[0]) {
            await client.query("COMMIT");
            return { status: "ALREADY_SCHEDULED", scheduleId: Number(raced.rows[0].id), state: raced.rows[0].estado };
        }
        const lateness = nowMinutes - targetMinutes;
        let state = "PENDIENTE";
        let resultCode = null;
        let error = null;
        let contentId = null;
        let body;
        const ratesResult = await client.query("SELECT * FROM rates WHERE id = 1");
        try {
            body = renderDailyRates(ratesResult.rows[0]);
        } catch (ratesError) {
            state = "FALLIDA";
            resultCode = "INVALID_RATES";
            error = String(ratesError.message || ratesError).slice(0, 1000);
        }
        if (body) contentId = await ensureDailyRatesContent(client, body);
        const secondsIntoMinute = now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
        const scheduledAt = new Date(now.getTime() - (nowMinutes - targetMinutes) * 60_000 - secondsIntoMinute);
        const inserted = await client.query(`
            INSERT INTO content_schedules
                (idioma, programada_para, estado, idempotency_key, content_item_id, result_code, error,
                 ejecutada_at)
            VALUES ('es', $1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN NOW() ELSE NULL END)
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id
        `, [scheduledAt, state, key, contentId, resultCode, error, state === "FALLIDA"]);
        const scheduleId = Number(inserted.rows[0]?.id || 0);
        if (scheduleId) {
            await client.query(`
                INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
                VALUES ('SCHEDULE', $1, $2, 'system', $3::jsonb)
            `, [scheduleId, state === "PENDIENTE" ? "CONTENT_DAILY_RATES_SCHEDULED" : "CONTENT_DAILY_RATES_FAILED",
                JSON.stringify({ date: local.date, time: config.time, timeZone: config.timeZone,
                    destination: config.destinationName, contentId, resultCode, error,
                    recoveredAfterScheduledTime: lateness > 0, latenessMinutes: lateness })]);
        }
        await client.query("COMMIT");
        return { status: state === "PENDIENTE" ? "SCHEDULED" : "INVALID_RATES", scheduleId, error };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

// El WhatsApp administrativo es un segundo destino del mismo programador,
// con su propia clave diaria y su propio resultado. Su fallo nunca cambia el
// estado ni impide ejecutar la publicación del grupo.
async function ensureDailyAdminRatesSchedule({ db = pool, now = new Date() } = {}) {
    const local = localParts(now, ZONA_NEGOCIO);
    const targetMinutes = minutesOfDay(ADMIN_SEND_TIME);
    const nowMinutes = Number(local.time.slice(0, 2)) * 60 + Number(local.time.slice(3, 5));
    if (nowMinutes < targetMinutes) return { status: "NOT_DUE" };
    const key = `daily-rates-admin-${local.date}`;
    const existing = await db.query("SELECT id, estado FROM content_schedules WHERE idempotency_key = $1 LIMIT 1", [key]);
    if (existing.rows[0]) return { status: "ALREADY_SCHEDULED", scheduleId: Number(existing.rows[0].id), state: existing.rows[0].estado };

    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
        const raced = await client.query("SELECT id, estado FROM content_schedules WHERE idempotency_key = $1 LIMIT 1", [key]);
        if (raced.rows[0]) {
            await client.query("COMMIT");
            return { status: "ALREADY_SCHEDULED", scheduleId: Number(raced.rows[0].id), state: raced.rows[0].estado };
        }

        let state = "PENDIENTE", resultCode = null, error = null, contentId = null;
        const ratesResult = await client.query("SELECT * FROM rates WHERE id = 1");
        let body;
        try {
            body = renderDailyRates(ratesResult.rows[0]);
        } catch (ratesError) {
            state = "FALLIDA";
            resultCode = "INVALID_RATES";
            error = String(ratesError.message || ratesError).slice(0, 1000);
        }
        if (body) contentId = await ensureDailyRatesContent(client, body);
        const secondsIntoMinute = now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
        const scheduledAt = new Date(now.getTime() - (nowMinutes - targetMinutes) * 60_000 - secondsIntoMinute);
        const inserted = await client.query(`
            INSERT INTO content_schedules
                (idioma, programada_para, estado, idempotency_key, content_item_id, result_code, error,
                 ejecutada_at)
            VALUES ('es', $1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN NOW() ELSE NULL END)
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id
        `, [scheduledAt, state, key, contentId, resultCode, error, state === "FALLIDA"]);
        const scheduleId = Number(inserted.rows[0]?.id || 0);
        if (scheduleId) {
            await client.query(`
                INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
                VALUES ('SCHEDULE', $1, $2, 'system', $3::jsonb)
            `, [scheduleId, state === "PENDIENTE" ? "CONTENT_DAILY_RATES_ADMIN_SCHEDULED" : "CONTENT_DAILY_RATES_ADMIN_FAILED",
                JSON.stringify({ date: local.date, time: ADMIN_SEND_TIME, timeZone: ZONA_NEGOCIO,
                    destination: "ADMIN_PHONE", contentId, resultCode, error,
                    recoveredAfterScheduledTime: nowMinutes > targetMinutes,
                    latenessMinutes: nowMinutes - targetMinutes })]);
        }
        await client.query("COMMIT");
        return { status: state === "PENDIENTE" ? "SCHEDULED" : "INVALID_RATES", scheduleId, error };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

async function sendAdminRates(schedule, dependencies = {}) {
    const db = dependencies.pool || pool;
    const started = async () => db.query(`
        INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
        VALUES ('SCHEDULE', $1, 'CONTENT_DAILY_RATES_ADMIN_STARTED', 'system',
                jsonb_build_object('destination', 'ADMIN_PHONE', 'contentId', $2::bigint))
    `, [schedule.scheduleId, schedule.contentId]);
    try {
        await started();
        const [{ getAdminPhone, enviarSeguro }, revision] = await Promise.all([
            Promise.resolve(dependencies.transport || require("../flows/shared")),
            db.query(`SELECT cuerpo FROM content_revisions WHERE content_item_id = $1 ORDER BY numero DESC LIMIT 1`, [schedule.contentId])
        ]);
        const phone = dependencies.adminPhone || getAdminPhone();
        if (!phone) throw Object.assign(new Error("ADMIN_PHONE no está configurado."), { code: "ADMIN_PHONE_NOT_CONFIGURED" });
        if (!revision.rows[0]?.cuerpo) throw new Error("No se encontró el contenido vigente de las tasas.");
        const delivered = await (dependencies.send || enviarSeguro)(phone, revision.rows[0].cuerpo);
        if (delivered === false) throw Object.assign(new Error("El transporte rechazó el envío al WhatsApp administrativo."), { code: "SEND_FAILED" });
        await db.query(`
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            VALUES ('SCHEDULE', $1, 'CONTENT_DAILY_RATES_ADMIN_SENT', 'system',
                    jsonb_build_object('destination', 'ADMIN_PHONE', 'contentId', $2::bigint, 'resultCode', 'SENT'))
        `, [schedule.scheduleId, schedule.contentId]);
        return { ok: true, code: "PUBLISHED", publication: null };
    } catch (error) {
        await db.query(`
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            VALUES ('SCHEDULE', $1, 'CONTENT_DAILY_RATES_ADMIN_SEND_FAILED', 'system', $2::jsonb)
        `, [schedule.scheduleId, JSON.stringify({ destination: "ADMIN_PHONE", contentId: schedule.contentId,
            resultCode: error.code || "SEND_FAILED", error: String(error.message || error).slice(0, 1000) })]);
        return { ok: false, code: error.code || "SEND_FAILED", error: String(error.message || error).slice(0, 1000) };
    }
}

module.exports = {
    RATE_ITEM_KEY, localParts, formatRate, renderDailyRates,
    minutesOfDay, getDailyRatesSettings, updateDailyRatesSettings, ensureDailyRatesSchedule,
    ADMIN_SEND_TIME, ensureDailyAdminRatesSchedule, sendAdminRates
};
