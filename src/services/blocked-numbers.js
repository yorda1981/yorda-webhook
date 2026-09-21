"use strict";

// ─────────────────────────────────────────
// NÚMEROS BLOQUEADOS
//
// Un número bloqueado significa CERO automatización de YordaBot hacia
// ese teléfono: sin respuesta al mensaje entrante, sin activar flows,
// sin llamar a OpenAI, sin recordatorios/saludos/otros jobs proactivos.
// Nunca borra ni toca customers/operations/entregas — el bloqueo es
// puramente una lista aparte que se consulta antes de automatizar nada.
//
// La comprobación se hace muy temprano en el webhook (index.js), antes
// de la pausa humana y del portón de gatillos — ver ese archivo.
// ─────────────────────────────────────────

const pool = require("../../db");

// Mismo criterio de formato que usa TODO el resto del sistema: "55" +
// DDD + número, sin "+", sin espacios (ver ENTREGA_CONTACT_PHONE por
// defecto, o cómo se guarda customers.phone). Sin esto, "+55...",
// "55..." y "11..." (sin código de país) serían tratados como números
// distintos y podrían evadir el bloqueo.
function normalizarTelefono(raw) {
    const soloDigitos = String(raw || "").replace(/\D/g, "");
    if (!soloDigitos) return "";
    if (soloDigitos.startsWith("55")) return soloDigitos;
    // 10 u 11 dígitos sin código de país (DDD + 8 o 9 dígitos) -> anteponer "55".
    if (soloDigitos.length === 10 || soloDigitos.length === 11) return "55" + soloDigitos;
    return soloDigitos;
}

async function estaBloqueado(rawPhone) {
    const phone = normalizarTelefono(rawPhone);
    if (!phone) return false;
    try {
        const r = await pool.query("SELECT 1 FROM blocked_numbers WHERE phone = $1 LIMIT 1", [phone]);
        return r.rows.length > 0;
    } catch (e) {
        // Tabla no migrada todavía (0010 sin correr) u otro error de DB:
        // degrada a "no bloqueado" -- nunca deja al webhook completo
        // caído por un problema de esta tabla. Mismo criterio que
        // webhook_events/idempotency_keys.
        console.warn("⚠️ blocked_numbers no disponible, se asume no bloqueado:", e.message);
        return false;
    }
}

async function bloquear(rawPhone, motivo) {
    const phone = normalizarTelefono(rawPhone);
    if (!phone) return { error: "Número inválido" };
    try {
        const r = await pool.query(
            "INSERT INTO blocked_numbers (phone, motivo) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING RETURNING *",
            [phone, motivo || null]
        );
        if (r.rows.length > 0) return { bloqueado: r.rows[0], yaExistia: false };
        // Ya estaba bloqueado -- se devuelve la fila existente tal cual,
        // sin pisar fecha/motivo originales.
        const existente = await pool.query("SELECT * FROM blocked_numbers WHERE phone = $1", [phone]);
        return { bloqueado: existente.rows[0], yaExistia: true };
    } catch (e) {
        console.error("❌ Error bloqueando número:", e.message);
        return { error: e.message };
    }
}

async function desbloquear(rawPhone) {
    const phone = normalizarTelefono(rawPhone);
    if (!phone) return false;
    try {
        const r = await pool.query("DELETE FROM blocked_numbers WHERE phone = $1 RETURNING phone", [phone]);
        return r.rows.length > 0;
    } catch (e) {
        console.error("❌ Error desbloqueando número:", e.message);
        return false;
    }
}

async function listarBloqueados() {
    try {
        const r = await pool.query("SELECT * FROM blocked_numbers ORDER BY created_at DESC");
        return r.rows;
    } catch (e) {
        console.error("❌ Error listando números bloqueados:", e.message);
        return [];
    }
}

// Filtra una lista de objetos (ej. filas de customers) descartando los
// que correspondan a un número bloqueado. Se usa en TODOS los jobs
// proactivos que le escriben a un cliente sin que haya un mensaje
// entrante de por medio (recordatorios CRM, saludo matutino, aviso de
// subida de nivel VIP) — nunca en acciones manuales del operador desde
// el dashboard, esas siguen funcionando igual para cualquier número.
async function filtrarNoBloqueados(items, obtenerTelefono = (x) => x.phone) {
    const resultado = [];
    for (const item of items) {
        // eslint-disable-next-line no-await-in-loop -- listas cortas (decenas, no miles), y estaBloqueado() ya está pensado como consulta puntual
        if (!(await estaBloqueado(obtenerTelefono(item)))) resultado.push(item);
    }
    return resultado;
}

module.exports = { normalizarTelefono, estaBloqueado, bloquear, desbloquear, listarBloqueados, filtrarNoBloqueados };
