"use strict";

// ─────────────────────────────────────────
// IDEMPOTENCIA POR REQUEST-ID — genérica, primer uso en
// src/flows/pedido-web-flow.js (crearEntregaManual).
//
// El frontend genera una clave (crypto.randomUUID()) una vez por intento
// de creación y la reenvía igual en cada reintento del MISMO intento
// (doble clic, reintento tras error de red). reclamar() es atómico
// (INSERT ... ON CONFLICT DO NOTHING) — de dos llamadas concurrentes con
// la misma clave, solo una puede "ganar" y seguir creando el recurso
// real; la otra se entera de inmediato de que ya hay una en curso o ya
// se resolvió, sin crear un duplicado.
//
// scope evita que claves de distintas acciones puedan chocar entre sí si
// en el futuro se reutiliza este mecanismo para otra cosa.
// ─────────────────────────────────────────

const pool = require("../../db");

async function reclamar(key, scope) {
    if (!key) return { nueva: true }; // sin key -> comportamiento anterior, sin dedup
    try {
        const ins = await pool.query(
            "INSERT INTO idempotency_keys (key, scope) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key",
            [key, scope]
        );
        if (ins.rows.length > 0) return { nueva: true };

        const existente = await pool.query(
            "SELECT resource_id FROM idempotency_keys WHERE key = $1 AND scope = $2",
            [key, scope]
        );
        return { nueva: false, resourceId: existente.rows[0]?.resource_id ?? null };
    } catch (e) {
        // Tabla todavía no migrada (0009 no corrida) u otro error de DB —
        // mismo criterio que webhook-guard.js con webhook_events: degrada
        // a "sin dedup" en vez de bloquear la creación real.
        console.warn("⚠️ idempotency_keys no disponible, sin dedup para esta corrida:", e.message);
        return { nueva: true };
    }
}

async function resolver(key, resourceId) {
    if (!key) return;
    try {
        await pool.query("UPDATE idempotency_keys SET resource_id = $1 WHERE key = $2", [resourceId, key]);
    } catch (e) {
        console.warn("⚠️ idempotency.resolver:", e.message);
    }
}

// Libera una clave reclamada cuando la creación real terminó fallando
// ANTES de llegar a crear cualquier recurso (ej. error de DB al insertar
// la operación) — sin esto, un reintento legítimo con la misma clave
// quedaría bloqueado para siempre viendo "ya hay una creación en curso".
// Nunca se llama después de que un recurso real ya se creó con éxito.
async function liberar(key) {
    if (!key) return;
    try {
        await pool.query("DELETE FROM idempotency_keys WHERE key = $1 AND resource_id IS NULL", [key]);
    } catch (e) {
        console.warn("⚠️ idempotency.liberar:", e.message);
    }
}

module.exports = { reclamar, resolver, liberar };
