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
async function yaFueProcesado(messageId, multimediaPausada = null) {
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
        const { rows } = multimediaPausada
            ? await pool.query(`
                INSERT INTO webhook_events
                    (message_id, media_phone, media_payload, media_status, media_not_before)
                VALUES (
                    $1,
                    CASE WHEN EXISTS (
                        SELECT 1 FROM customers WHERE phone = $2 AND pausa_hasta > NOW()
                    ) THEN $2 ELSE NULL END,
                    CASE WHEN EXISTS (
                        SELECT 1 FROM customers WHERE phone = $2 AND pausa_hasta > NOW()
                    ) THEN $3::jsonb ELSE NULL END,
                    CASE WHEN EXISTS (
                        SELECT 1 FROM customers WHERE phone = $2 AND pausa_hasta > NOW()
                    ) THEN 'DEFERRED' ELSE NULL END,
                    (SELECT pausa_hasta FROM customers WHERE phone = $2 AND pausa_hasta > NOW())
                )
                ON CONFLICT (message_id) DO NOTHING RETURNING message_id
            `, [messageId, multimediaPausada.phone, JSON.stringify(multimediaPausada.payload)])
            : await pool.query(
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

// Los adjuntos recibidos durante la pausa humana se conservan en la misma
// fila de deduplicación. Se reclaman una sola vez después de que venza la
// pausa. PROCESSING no se reintenta automáticamente: un reinicio durante el
// procesamiento deja el caso para revisión en vez de duplicar una respuesta.
async function reclamarAdjuntosDiferidos(limite = 10) {
    const { rows } = await pool.query(`
        WITH candidatos AS (
            SELECT w.message_id
            FROM webhook_events w
            JOIN customers c ON c.phone = w.media_phone
            WHERE w.media_status = 'DEFERRED'
              AND w.media_not_before <= NOW()
              AND (c.pausa_hasta IS NULL OR c.pausa_hasta <= NOW())
            ORDER BY w.received_at
            FOR UPDATE OF w SKIP LOCKED
            LIMIT $1
        )
        UPDATE webhook_events w
        SET media_status = 'PROCESSING'
        FROM candidatos x
        WHERE w.message_id = x.message_id AND w.media_status = 'DEFERRED'
        RETURNING w.message_id, w.media_phone, w.media_payload
    `, [limite]);
    return rows;
}

async function conservarAdjuntoSiPausado(messageId, multimediaPausada) {
    if (!messageId || !multimediaPausada?.phone || !multimediaPausada?.payload) return false;
    const { rows } = await pool.query(`
        UPDATE webhook_events w
        SET media_phone = $2,
            media_payload = $3::jsonb,
            media_status = 'DEFERRED',
            media_not_before = c.pausa_hasta
        FROM customers c
        WHERE w.message_id = $1
          AND c.phone = $2
          AND c.pausa_hasta > NOW()
          AND w.media_status IS NULL
        RETURNING w.message_id
    `, [messageId, multimediaPausada.phone, JSON.stringify(multimediaPausada.payload)]);
    return rows.length > 0;
}

async function marcarAdjuntoDiferido(messageId, estado) {
    if (!messageId || !["PROCESSED", "IGNORED", "REVIEW_REQUIRED"].includes(estado)) return;
    await pool.query(
        "UPDATE webhook_events SET media_status = $2 WHERE message_id = $1 AND media_status IN ('PROCESSING', 'DEFERRED')",
        [messageId, estado]
    );
}

async function devolverAdjuntoACola(messageId, pausaHasta) {
    if (!messageId || !pausaHasta) return;
    await pool.query(
        "UPDATE webhook_events SET media_status = 'DEFERRED', media_not_before = $2 WHERE message_id = $1 AND media_status = 'PROCESSING'",
        [messageId, pausaHasta]
    );
}

// Job de limpieza (Fase 6) — borra eventos de más de 1 día. Sin esto la
// tabla crecería para siempre; el dedup real solo necesita una ventana
// corta (los reintentos de Z-API ocurren en minutos, no en días).
async function limpiarWebhookEventsViejos() {
    try {
        const r = await pool.query(
            `DELETE FROM webhook_events
             WHERE received_at < NOW() - INTERVAL '1 day'
               AND (media_status IS NULL OR media_status IN ('PROCESSED', 'IGNORED'))`
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

async function obtenerPausaHumanaHasta(phone) {
    if (!phone) return null;
    try {
        const r = await pool.query("SELECT pausa_hasta FROM customers WHERE phone = $1", [phone]);
        return r.rows[0]?.pausa_hasta || null;
    } catch (e) {
        console.error("❌ obtenerPausaHumanaHasta:", e.message);
        return null;
    }
}

// Eventos de sistema de Z-API (como REVOKE al borrar un mensaje) no son
// entradas conversacionales y nunca deben activar una respuesta del bot.
function isNonConversationNotification(body) {
    return Boolean(body && (body.notification || body.isStatusReply));
}

module.exports = {
    yaFueProcesado,
    activarPausaHumana,
    enPausaHumana,
    obtenerPausaHumanaHasta,
    isNonConversationNotification,
    limpiarWebhookEventsViejos,
    reclamarAdjuntosDiferidos,
    conservarAdjuntoSiPausado,
    marcarAdjuntoDiferido,
    devolverAdjuntoACola,
    // Expuesto solo para tests (limpiar estado entre casos).
    _internos: { mensajesProcesados, ULTIMA_PAUSA_CACHE }
};
