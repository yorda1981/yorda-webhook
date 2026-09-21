"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — límites separados de /admin (src/middleware/admin-rate-limiters.js)
//
// Objetivo concreto: demuestra que agotar el contador de LECTURA (el que
// satura el polling del dashboard cada 30s) NUNCA consume ni bloquea el
// contador de ESCRITURA (confirmar, completar, crear/marcar entrega).
// Antes eran un único rateLimit() compartido — este es exactamente el bug
// reportado ("demasiados intentos" al confirmar/completar/crear entrega).
//
// No usa supertest ni levanta un servidor: invoca los middlewares de
// express-rate-limit directamente con un req/res mínimos compatibles con
// lo que la librería necesita (ip, headers, app.get, status/send/setHeader).
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const { adminReadLimiter, adminWriteLimiter } = require("../src/middleware/admin-rate-limiters");

function fakeReq(ip) {
    return { ip, headers: {}, app: { get: () => false } };
}

function fakeRes() {
    return {
        statusCode: 200,
        writableEnded: false,
        headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        getHeader(k) { return this.headers[k]; },
        removeHeader(k) { delete this.headers[k]; },
        append(k, v) { this.headers[k] = v; },
        status(code) { this.statusCode = code; return this; },
        send(body) { this.body = body; this.writableEnded = true; return this; },
        json(body) { this.body = body; this.writableEnded = true; return this; },
        end() { this.writableEnded = true; return this; },
        on() {}
    };
}

async function dispararN(limiter, ip, n) {
    const resultados = [];
    for (let i = 0; i < n; i++) {
        const req = fakeReq(ip);
        const res = fakeRes();
        let llamadoNext = false;
        await limiter(req, res, () => { llamadoNext = true; });
        resultados.push({ bloqueado: !llamadoNext, statusCode: res.statusCode });
    }
    return resultados;
}

test("adminReadLimiter y adminWriteLimiter son instancias completamente independientes", () => {
    assert.notEqual(adminReadLimiter, adminWriteLimiter);
});

test("agotar adminReadLimiter (polling) NUNCA bloquea adminWriteLimiter para la misma IP", async () => {
    const ip = "203.0.113.10";

    // Simula el polling del dashboard saturando el límite de LECTURA.
    const lecturas = await dispararN(adminReadLimiter, ip, 305); // supera el max:300
    const algunaLecturaBloqueada = lecturas.some((r) => r.bloqueado);
    assert.equal(algunaLecturaBloqueada, true, "el test no prueba nada si nunca se satura la lectura");

    // La escritura, para la MISMA ip, en el mismo instante, debe pasar
    // igual -- es exactamente la acción real (confirmar/completar/crear
    // entrega) que hoy queda bloqueada por error.
    const req = fakeReq(ip);
    const res = fakeRes();
    let llamadoNext = false;
    await adminWriteLimiter(req, res, () => { llamadoNext = true; });
    assert.equal(llamadoNext, true, "una acción de escritura no debe verse afectada por el polling de lectura");
    assert.notEqual(res.statusCode, 429);
});

test("múltiples GET de lectura no consumen el presupuesto de escritura (contadores separados)", async () => {
    const ip = "203.0.113.20";
    await dispararN(adminReadLimiter, ip, 250); // dentro del límite de lectura, pero muchas peticiones

    // El contador de escritura para esta IP debe seguir en cero -- puede
    // aceptar su propio máximo completo sin que la lectura le haya
    // restado nada.
    const escrituras = await dispararN(adminWriteLimiter, ip, 30); // exactamente max:30
    assert.equal(escrituras.every((r) => !r.bloqueado), true, "las 30 escrituras permitidas deben pasar completas");
});

test("adminWriteLimiter sigue protegiendo contra abuso real: la escritura #31 en el mismo minuto sí se bloquea", async () => {
    const ip = "203.0.113.30";
    await dispararN(adminWriteLimiter, ip, 30);
    const req = fakeReq(ip);
    const res = fakeRes();
    let llamadoNext = false;
    await adminWriteLimiter(req, res, () => { llamadoNext = true; });
    assert.equal(llamadoNext, false);
    assert.equal(res.statusCode, 429);
});

test("IPs distintas no comparten contador (ni en lectura ni en escritura)", async () => {
    const ipA = "203.0.113.40";
    const ipB = "203.0.113.41";
    await dispararN(adminWriteLimiter, ipA, 30); // agota el límite de A

    const req = fakeReq(ipB);
    const res = fakeRes();
    let llamadoNext = false;
    await adminWriteLimiter(req, res, () => { llamadoNext = true; });
    assert.equal(llamadoNext, true, "una IP distinta no debe heredar el bloqueo de otra");
});
