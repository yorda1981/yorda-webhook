"use strict";

// ─────────────────────────────────────────
// CONTADOR DE INTENTOS DE AUTENTICACIÓN INVÁLIDOS
//
// Reemplaza al viejo authAttemptLimiter (express-rate-limit con
// skipSuccessfulRequests: true, montado globalmente en `/admin`). Ese
// diseño contaba como "fallo" CUALQUIER respuesta >= 400 de CUALQUIER
// ruta bajo /admin — incluidos los 404 de los guards de idempotencia
// (Fase 3) y los propios 429 de adminLimiter. 5 de esas respuestas en
// 15 minutos bloqueaban TODO /admin para esa IP, aunque el token fuera
// perfectamente válido.
//
// Este módulo solo cuenta lo que dice contar: un token realmente
// inválido o ausente. Se incrementa exclusivamente desde
// src/middleware/admin-auth.js, nunca desde el resultado de una ruta.
// ─────────────────────────────────────────

const VENTANA_MS = 15 * 60 * 1000;
const MAX_INTENTOS = 5;

const intentos = new Map(); // ip -> { count, resetAt }

function bloqueado(ip) {
    if (!ip) return false;
    const entry = intentos.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
        intentos.delete(ip);
        return false;
    }
    return entry.count >= MAX_INTENTOS;
}

function registrarFallo(ip) {
    if (!ip) return;
    const ahora = Date.now();
    const entry = intentos.get(ip);
    if (!entry || ahora > entry.resetAt) {
        intentos.set(ip, { count: 1, resetAt: ahora + VENTANA_MS });
    } else {
        entry.count++;
    }
}

// Token correcto -> el intento fue legítimo, se borra el historial de
// fallos de esta IP (no tiene sentido seguir penalizando fallos viejos
// una vez que se demostró que quien pide es quien dice ser).
function registrarExito(ip) {
    if (!ip) return;
    intentos.delete(ip);
}

module.exports = {
    bloqueado,
    registrarFallo,
    registrarExito,
    MAX_INTENTOS,
    VENTANA_MS,
    // Solo para tests.
    _internos: { intentos }
};
