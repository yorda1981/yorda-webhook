"use strict";

// ─────────────────────────────────────────
// WEBHOOK GUARD — deduplicación de mensajes + pausa humana
//
// Extraído de index.js tal cual (mismo comportamiento, mismos valores)
// para poder probarlo con tests reales sin arrancar todo el servidor.
// Ver test/webhook-guard.test.js.
// ─────────────────────────────────────────

const pool = require("../../db");
const { log } = require("../utils/structured-logger");

// ── DEDUPLICACIÓN DE messageId ──
//
// Fase 6: la fuente de verdad pasó a ser la tabla `webhook_events`
// (migrations/0008_webhook_events_dedup.sql) — un INSERT ... ON CONFLICT
// DO NOTHING ... RETURNING es atómico incluso con dos instancias
// escribiendo al mismo tiempo, cosa que el Set en memoria nunca pudo
// garantizar (cada instancia tiene el suyo) ni sobrevivir a un reinicio
// de Railway.
//
// El Set en memoria NO se eliminó: sigue como filtro rápido de primera
// línea (evita un round-trip a la DB para el caso común de un mensaje que
// claramente es nuevo dentro del mismo proceso). Pero si el Set dice "no
// lo tengo", igual se confirma contra Postgres antes de decidir — nunca
// al revés. Compatibilidad: si la tabla no existiera todavía (DB vieja
// sin correr las migraciones nuevas) o hay un error de conexión, el
// comportamiento cae al Set en memoria únicamente (igual que antes de
// esta fase), nunca bloquea el webhook por un problema de la DB.
const mensajesProcesados = new Set();
const VENTANA_DEDUP_MS = 5 * 60 * 1000;

// Devuelve true si YA se había procesado este messageId (el caller debe
// cortar ahí). Si es nuevo, lo marca (memoria + DB) y devuelve false.
async function yaFueProcesado(messageId) {
    if (!messageId) return false;

    if (mensajesProcesados.has(messageId)) {
        log("WEBHOOK_DUPLICATE", { messageId, fuente: "memoria" });
        return true;
    }

    // Aunque el Set diga "nuevo", puede haberlo procesado OTRA instancia
    // hace instantes — por eso la DB manda. Se marca en memoria ANTES de
    // await para que dos llamadas casi simultáneas en este mismo proceso
    // (mismo tick) no hagan ambas el INSERT.
    mensajesProcesados.add(messageId);
    setTimeout(() => mensajesProcesados.delete(messageId), VENTANA_DEDUP_MS).unref();

    try {
        const { rows } = await pool.query(
            "INSERT INTO webhook_events (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING RETURNING message_id",
            [messageId]
        );
        const esNuevo = rows.length > 0;
        if (!esNuevo) log("WEBHOOK_DUPLICATE", { messageId, fuente: "postgres" });
        return !esNuevo;
    } catch (e) {
        // Tabla inexistente (DB sin migrar todavía) u otro error de
        // conexión: degrada al Set en memoria, nunca tumba el webhook.
        console.warn("⚠️ webhook_events no disponible, dedup solo en memoria para esta corrida:", e.message);
        return false;
    }
}

// Job de limpieza (Fase 6) — borra eventos de más de 1 día. Sin esto la
// tabla crecería para siempre; el dedup real solo necesita una ventana
// corta (los reintentos de Z-API ocurren en minutos, no en días).
async function limpiarWebhookEventsViejos() {
    try {
        const r = await pool.query(
            "DELETE FROM webhook_events WHERE received_at < NOW() - INTERVAL '1 day'"
        );
        if (r.rowCount > 0) console.log(`🧹 webhook_events: ${r.rowCount} evento(s) viejo(s) borrados`);
    } catch (e) {
        console.warn("⚠️ limpiarWebhookEventsViejos:", e.message);
    }
}

// ─────────────────────────────────────────
// PAUSA HUMANA — persistida en PostgreSQL
// Sobrevive reinicios de Railway.
// Se activa cuando el operador escribe desde
// el WhatsApp directamente (fromMe + !fromApi).
//
// Optimización (28/07/2026): antes esto hacía 2-3
// queries por CADA mensaje manual (UPDATE + SELECT +
// INSERT). Cuando el operador manda varios mensajes
// seguidos al mismo cliente, o hace rondas de disparos
// a varios clientes, esto multiplicaba las queries y
// disparó el consumo de cómputo en Neon.
// Ahora: 1) una sola query UPSERT, y 2) una caché en
// memoria que evita volver a tocar la DB si ya se
// extendió la pausa de ese número hace menos de 60s.
// ─────────────────────────────────────────

const ULTIMA_PAUSA_CACHE = new Map(); // phone -> timestamp (ms) de la última escritura real en DB
const DEBOUNCE_PAUSA_MS = 60 * 1000;  // no reescribir la misma pausa antes de 60s
const MINUTOS_PAUSA = 10;

async function activarPausaHumana(phone) {
    if (!phone) return;
    if (!String(phone).startsWith("55")) return;

    const ahora = Date.now();
    const ultima = ULTIMA_PAUSA_CACHE.get(phone);
    if (ultima && (ahora - ultima) < DEBOUNCE_PAUSA_MS) {
        // Ya se extendió la pausa hace poco (ráfaga de mensajes del operador
        // al mismo cliente) — el cliente sigue silenciado igual, no hace
        // falta volver a escribir en PostgreSQL.
        return;
    }

    try {
        await pool.query(`
            INSERT INTO customers (phone, pausa_hasta, created_at, updated_at)
            VALUES ($1, NOW() + ($2 * INTERVAL '1 minute'), NOW(), NOW())
            ON CONFLICT (phone) DO UPDATE
            SET pausa_hasta = NOW() + ($2 * INTERVAL '1 minute'),
                updated_at  = NOW()
        `, [phone, MINUTOS_PAUSA]);
        ULTIMA_PAUSA_CACHE.set(phone, ahora);
        console.log(`⏸️ Pausa humana (PG): ${MINUTOS_PAUSA} min → ${phone}`);
    } catch (e) {
        console.error("❌ activarPausaHumana:", e.message);
    }
}

async function enPausaHumana(phone) {
    if (!phone) return false;
    try {
        const r = await pool.query(
            "SELECT pausa_hasta FROM customers WHERE phone = $1",
            [phone]
        );
        if (!r.rows.length || !r.rows[0].pausa_hasta) return false;
        return new Date(r.rows[0].pausa_hasta) > new Date();
    } catch (e) {
        console.error("❌ enPausaHumana:", e.message);
        return false;   // ante la duda, dejar pasar al bot
    }
}

module.exports = {
    yaFueProcesado,
    activarPausaHumana,
    enPausaHumana,
    limpiarWebhookEventsViejos,
    // Expuesto solo para tests (limpiar estado entre casos).
    _internos: { mensajesProcesados, ULTIMA_PAUSA_CACHE }
};
