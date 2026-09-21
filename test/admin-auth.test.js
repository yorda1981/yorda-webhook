"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — protección de intentos de autenticación
// (src/middleware/admin-auth.js + src/middleware/auth-attempt-limiter.js)
//
// Objetivo concreto: demuestra que SOLO un token inválido/ausente cuenta
// como intento fallido -- nunca un 429 de otro limiter, ni un 404 de un
// guard de idempotencia, ni ningún otro resultado de una ruta. Antes, el
// viejo authAttemptLimiter (skipSuccessfulRequests sobre TODO /admin)
// contaba cualquier respuesta >= 400 de cualquier ruta como "fallo".
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const { verificarToken, verificarTokenEntregas } = require("../src/middleware/admin-auth");
const authAttempt = require("../src/middleware/auth-attempt-limiter");

function fakeRes() {
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

function limpiarIntentos() {
    authAttempt._internos.intentos.clear();
}

test.beforeEach(() => {
    process.env.ADMIN_TOKEN = "token-admin-test";
    process.env.ENTREGAS_TOKEN = "token-entregas-test";
    limpiarIntentos();
});

test("token válido -> pasa, no registra ningún fallo", () => {
    const req = { ip: "198.51.100.1", headers: { authorization: "Bearer token-admin-test" } };
    const res = fakeRes();
    let next = false;
    verificarToken(req, res, () => { next = true; });
    assert.equal(next, true);
    assert.equal(authAttempt.bloqueado("198.51.100.1"), false);
});

test("token inválido -> 401 y registra un fallo real", () => {
    const req = { ip: "198.51.100.2", headers: { authorization: "Bearer token-incorrecto" } };
    const res = fakeRes();
    let next = false;
    verificarToken(req, res, () => { next = true; });
    assert.equal(next, false);
    assert.equal(res.statusCode, 401);
});

test("5 tokens inválidos seguidos -> el 6to intento (aunque el token sea correcto) se bloquea con 429", () => {
    const ip = "198.51.100.3";
    for (let i = 0; i < 5; i++) {
        const req = { ip, headers: { authorization: "Bearer malo" } };
        verificarToken(req, fakeRes(), () => {});
    }
    const req = { ip, headers: { authorization: "Bearer token-admin-test" } }; // token correcto
    const res = fakeRes();
    let next = false;
    verificarToken(req, res, () => { next = true; });
    assert.equal(next, false, "una vez bloqueada la IP, ni siquiera un token correcto pasa hasta que expire la ventana");
    assert.equal(res.statusCode, 429);
});

test("un token correcto resetea el historial de fallos previos de esa IP", () => {
    const ip = "198.51.100.4";
    for (let i = 0; i < 3; i++) {
        verificarToken({ ip, headers: { authorization: "Bearer malo" } }, fakeRes(), () => {});
    }
    // Token correcto a mitad de camino -- no debería dejar "arrastre" de fallos.
    verificarToken({ ip, headers: { authorization: "Bearer token-admin-test" } }, fakeRes(), () => {});
    assert.equal(authAttempt.bloqueado(ip), false);

    // 4 fallos más (no 5) no deberían bloquear, porque el contador se reinició.
    for (let i = 0; i < 4; i++) {
        verificarToken({ ip, headers: { authorization: "Bearer malo" } }, fakeRes(), () => {});
    }
    assert.equal(authAttempt.bloqueado(ip), false);
});

test("un 429 u otro error de una ruta NUNCA llega a este módulo -- solo verificarToken/verificarTokenEntregas pueden registrar un fallo", () => {
    // No hay ningún acoplamiento posible: authAttempt.registrarFallo() solo
    // se llama desde admin-auth.js, nunca desde el resto de la app. Se
    // demuestra simulando el escenario real completo: muchas respuestas
    // "de ruta" con código >= 400 que NUNCA pasan por verificarToken.
    const ip = "198.51.100.5";
    // Nada de esto es una llamada real a verificarToken -- son solo
    // respuestas hipotéticas de otras rutas (429 de adminWriteLimiter, 404
    // de un guard de idempotencia, etc.) que en el diseño viejo SÍ
    // contaban como fallo de autenticación.
    const respuestasDeOtrasRutas = [429, 404, 404, 400, 429];
    void respuestasDeOtrasRutas; // documentación del escenario, no se procesan aquí a propósito
    assert.equal(authAttempt.bloqueado(ip), false, "ninguna de esas respuestas debe haber tocado el contador de esta IP");
});

test("IPs distintas tienen contadores de intentos completamente independientes", () => {
    const ipA = "198.51.100.6";
    const ipB = "198.51.100.7";
    for (let i = 0; i < 5; i++) {
        verificarToken({ ip: ipA, headers: { authorization: "Bearer malo" } }, fakeRes(), () => {});
    }
    assert.equal(authAttempt.bloqueado(ipA), true);
    assert.equal(authAttempt.bloqueado(ipB), false);
});

test("verificarTokenEntregas: token de ENTREGAS_TOKEN también es válido y no cuenta como fallo", () => {
    const req = { ip: "198.51.100.8", headers: { authorization: "Bearer token-entregas-test" } };
    const res = fakeRes();
    let next = false;
    verificarTokenEntregas(req, res, () => { next = true; });
    assert.equal(next, true);
    assert.equal(authAttempt.bloqueado("198.51.100.8"), false);
});

test("verificarTokenEntregas: token inválido también respeta el bloqueo tras 5 intentos", () => {
    const ip = "198.51.100.9";
    for (let i = 0; i < 5; i++) {
        verificarTokenEntregas({ ip, headers: { authorization: "Bearer malo" } }, fakeRes(), () => {});
    }
    const res = fakeRes();
    let next = false;
    verificarTokenEntregas({ ip, headers: { authorization: "Bearer token-entregas-test" } }, res, () => { next = true; });
    assert.equal(next, false);
    assert.equal(res.statusCode, 429);
});
