"use strict";

const pool = require("../../db");
const env = require("../config/env");
const { SCHEMA_STATES } = require("./schema-status");
const dailyRates = require("./content-daily-rates");

const SCHEDULER_LABEL_BY_SCHEMA = Object.freeze({
    [SCHEMA_STATES.VERIFICANDO]: "VERIFICANDO ESQUEMA",
    [SCHEMA_STATES.PENDIENTE]: "ESQUEMA PENDIENTE",
    [SCHEMA_STATES.NO_VERIFICADO]: "ESQUEMA NO VERIFICADO"
});

function publisherLabel() {
    const zapiConfigured = Boolean(env.ZAPI_INSTANCE && env.ZAPI_TOKEN && env.ZAPI_CLIENT_TOKEN);
    return zapiConfigured ? "CONFIGURADO" : "CONFIGURACIÓN INCOMPLETA";
}

// Sin esquema verificado no se consultan las tablas content_*: puede que no existan.
function schemaBlockedSnapshot(schema) {
    return {
        counts: { programadas: 0, ejecutadas: 0, fallidas: 0, canceladas: 0 },
        latestPublication: null,
        nextSchedule: null,
        events: [],
        destinations: [],
        dailyRates: null,
        latestDailyRatesSchedule: null,
        latestDailyRatesAdminSchedule: null,
        schema,
        services: {
            scheduler: SCHEDULER_LABEL_BY_SCHEMA[schema.estado] || "ESQUEMA NO VERIFICADO",
            publisher: publisherLabel()
        }
    };
}

async function getOperationsSnapshot(db = pool, { schedulerStarted = false, schema = null } = {}) {
    if (schema && schema.estado !== SCHEMA_STATES.COMPLETO) return schemaBlockedSnapshot(schema);
    const [counts, latest, next, events, destinations, ratesSettings, latestRatesSchedule, latestAdminRatesSchedule] = await Promise.all([
        db.query(`
            SELECT
                COUNT(*) FILTER (WHERE estado = 'PENDIENTE')::int AS programadas,
                COUNT(*) FILTER (WHERE estado = 'EJECUTADA')::int AS ejecutadas,
                COUNT(*) FILTER (WHERE estado IN ('FALLIDA', 'AMBIGUA'))::int AS fallidas,
                COUNT(*) FILTER (WHERE estado = 'CANCELADA')::int AS canceladas
            FROM content_schedules
        `),
        db.query(`
            SELECT cp.id, cp.publicada_at, ci.titulo, cp.canal, cp.destino_ref
            FROM content_publications cp
            JOIN content_items ci ON ci.id = cp.content_item_id
            WHERE cp.estado = 'PUBLICADA'
            ORDER BY cp.publicada_at DESC, cp.id DESC
            LIMIT 1
        `),
        db.query(`
            SELECT id, idioma, programada_para
            FROM content_schedules
            WHERE estado = 'PENDIENTE'
            ORDER BY programada_para ASC, id ASC
            LIMIT 1
        `),
        db.query(`
            SELECT entity_type, entity_id, event_type, actor, datos, ocurrido_at
            FROM content_events
            ORDER BY ocurrido_at DESC, id DESC
            LIMIT 15
        `),
        db.query(`
            SELECT id, tipo, external_id, nombre, activo, validado_at
            FROM content_destinations
            ORDER BY activo DESC, nombre ASC, id ASC
        `),
        dailyRates.getDailyRatesSettings(db),
        db.query(`
            SELECT id, programada_para, ejecutada_at, estado, result_code, error, idempotency_key
            FROM content_schedules WHERE idempotency_key LIKE 'daily-rates-____-__-__'
            ORDER BY id DESC LIMIT 1
        `),
        db.query(`
            SELECT id, programada_para, ejecutada_at, estado, result_code, error, idempotency_key
            FROM content_schedules WHERE idempotency_key LIKE 'daily-rates-admin-%'
            ORDER BY id DESC LIMIT 1
        `)
    ]);

    return {
        counts: counts.rows[0] || { programadas: 0, ejecutadas: 0, fallidas: 0, canceladas: 0 },
        latestPublication: latest.rows[0] || null,
        nextSchedule: next.rows[0] || null,
        events: events.rows,
        destinations: destinations.rows,
        dailyRates: ratesSettings,
        latestDailyRatesSchedule: latestRatesSchedule.rows[0] || null,
        latestDailyRatesAdminSchedule: latestAdminRatesSchedule.rows[0] || null,
        schema,
        services: {
            scheduler: schedulerStarted ? "INICIADO" : "NO INICIADO",
            publisher: publisherLabel()
        }
    };
}

module.exports = { getOperationsSnapshot };

