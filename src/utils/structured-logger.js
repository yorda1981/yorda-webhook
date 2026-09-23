"use strict";

// ─────────────────────────────────────────
// LOGGING ESTRUCTURADO — Fase 5
//
// Una línea JSON por evento, a stdout — Railway ya captura eso como log,
// no hace falta ninguna plataforma externa. Se puede grep-ear por
// "evento":"OPERATION_CREATED" o por un operationId/messageId/phone
// puntual para seguir el rastro de una operación.
//
// Eventos cubiertos (ver README para la lista completa y qué dispara cada
// uno): WEBHOOK_RECEIVED, WEBHOOK_DUPLICATE, WEBHOOK_REJECTED,
// MESSAGE_PROCESSED, MESSAGE_DISCARDED, OCR_SUCCESS, OCR_FAILED, OPERATION_CREATED,
// OPERATION_CONFIRMED, OPERATION_COMPLETED, DELIVERY_CREATED,
// DELIVERY_COMPLETED, EXTERNAL_API_ERROR.
//
// Qué NUNCA debe pasarse en `datos`: tokens, API keys, secretos, la clave
// PIX u otros datos PIX completos, números completos de tarjeta,
// documentos, o cualquier contenido libre del cliente que no haga falta.
// Responsabilidad principal del caller (pasar solo campos-resumen); esta
// función redacta por nombre de campo como defensa adicional.
// ─────────────────────────────────────────

const EVENTOS_VALIDOS = new Set([
    "WEBHOOK_RECEIVED", "WEBHOOK_DUPLICATE", "WEBHOOK_REJECTED",
    "MESSAGE_PROCESSED", "MESSAGE_DISCARDED", "OCR_SUCCESS", "OCR_FAILED",
    "OPERATION_CREATED", "OPERATION_CONFIRMED", "OPERATION_COMPLETED",
    "DELIVERY_CREATED", "DELIVERY_COMPLETED", "DELIVERY_INTERNAL_NOTIFICATION", "DELIVERY_PAYMENT_RECEIPT", "EXTERNAL_API_ERROR"
]);

// Nombres de campo que jamás se imprimen tal cual, sin importar qué
// mande el caller — coincide sin distinguir mayúsculas ni separador.
const CAMPO_PROHIBIDO = /token|secret|api[_-]?key|password|pix[_-]?key|^tarjeta$|tarjeta_|card(number)?|documento/i;

function redactar(datos) {
    const limpio = {};
    for (const [key, value] of Object.entries(datos || {})) {
        limpio[key] = CAMPO_PROHIBIDO.test(key) ? "[REDACTED]" : value;
    }
    return limpio;
}

// Solo los últimos 4 dígitos — alcanza para correlacionar sin exponer el
// número completo del cliente en logs.
function enmascararTelefono(phone) {
    if (!phone) return null;
    const s = String(phone);
    return s.length > 4 ? `***${s.slice(-4)}` : s;
}

function log(evento, datos = {}) {
    if (!EVENTOS_VALIDOS.has(evento)) {
        console.warn(`⚠️ structured-logger: evento desconocido "${evento}"`);
    }
    const payload = redactar(datos);
    if (payload.phone) payload.phone = enmascararTelefono(payload.phone);
    console.log(JSON.stringify({ evento, ts: new Date().toISOString(), ...payload }));
}

module.exports = { log, enmascararTelefono, redactar, EVENTOS_VALIDOS };
