"use strict";

// ─────────────────────────────────────────
// WEBHOOK GUARD — deduplicación de mensajes + pausa humana
//
// Extraído de index.js tal cual (mismo comportamiento, mismos valores)
// para poder probarlo con tests reales sin arrancar todo el servidor.
// Ver test/webhook-guard.test.js.
// ─────────────────────────────────────────

const pool = require("../../db");

// ── DEDUPLICACIÓN DE messageId ──
// Los reintentos de Z-API (mismo evento reenviado) traen el mismo
// messageId/id/zeId. Se recuerda por 5 minutos — tiempo de sobra para
// cualquier reintento real del proveedor, sin dejar crecer el Set para
// siempre. Vive en memoria del proceso: se pierde si Railway reinicia,
// pero eso solo abre una ventana de "no protegido" al reiniciar, nunca
// un falso "ya procesado".
const mensajesProcesados = new Set();
const VENTANA_DEDUP_MS = 5 * 60 * 1000;

// Devuelve true si YA se había procesado este messageId (el caller debe
// cortar ahí). Si es nuevo, lo marca y devuelve false — atómico: no hay
// forma de llamarlo dos veces seguidas para el mismo id y que ambas
// devuelvan false.
function yaFueProcesado(messageId) {
    if (!messageId) return false;
    if (mensajesProcesados.has(messageId)) return true;
    mensajesProcesados.add(messageId);
    // unref(): que este temporizador nunca sea, por sí solo, la razón por
    // la que el proceso siga vivo (relevante sobre todo para los tests,
    // que no tienen un servidor HTTP escuchando de fondo) — en producción
    // no cambia nada, el listener de Express ya mantiene el proceso activo.
    setTimeout(() => mensajesProcesados.delete(messageId), VENTANA_DEDUP_MS).unref();
    return false;
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
    // Expuesto solo para tests (limpiar estado entre casos).
    _internos: { mensajesProcesados, ULTIMA_PAUSA_CACHE }
};
