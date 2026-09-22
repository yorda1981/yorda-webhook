"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — logging estructurado (src/utils/structured-logger.js)
//
// No mockea nada externo — solo captura console.log para inspeccionar el
// JSON que se hubiera escrito, y confirma que los campos sensibles nunca
// salen tal cual.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const { log, enmascararTelefono, redactar, EVENTOS_VALIDOS } = require("../src/utils/structured-logger");

function capturarLog(fn) {
    const original = console.log;
    let capturado = null;
    console.log = (linea) => { capturado = linea; };
    try {
        fn();
    } finally {
        console.log = original;
    }
    return capturado ? JSON.parse(capturado) : null;
}

test("emite JSON de una sola línea con el evento y timestamp", () => {
    const r = capturarLog(() => log("OPERATION_CREATED", { operationId: 5 }));
    assert.equal(r.evento, "OPERATION_CREATED");
    assert.equal(r.operationId, 5);
    assert.ok(r.ts); // ISO timestamp presente
});

test("enmascara el teléfono a los últimos 4 dígitos", () => {
    const r = capturarLog(() => log("MESSAGE_PROCESSED", { phone: "5511988887777" }));
    assert.equal(r.phone, "***7777");
});

test("nunca imprime el teléfono completo", () => {
    const r = capturarLog(() => log("MESSAGE_PROCESSED", { phone: "5511988887777" }));
    assert.equal(JSON.stringify(r).includes("5511988887777"), false);
});

test("redactar: campos con token/secret/apiKey/password/pixKey/tarjeta -> [REDACTED]", () => {
    const limpio = redactar({
        token: "abc",
        apiKey: "def",
        api_key: "ghi",
        secret: "jkl",
        password: "mno",
        pixKey: "clave-pix-real",
        tarjeta: "9218123456789012",
        documento: "foto-cedula-url",
        monto: 100 // no sensible, debe pasar tal cual
    });
    assert.equal(limpio.token, "[REDACTED]");
    assert.equal(limpio.apiKey, "[REDACTED]");
    assert.equal(limpio.api_key, "[REDACTED]");
    assert.equal(limpio.secret, "[REDACTED]");
    assert.equal(limpio.password, "[REDACTED]");
    assert.equal(limpio.pixKey, "[REDACTED]");
    assert.equal(limpio.tarjeta, "[REDACTED]");
    assert.equal(limpio.documento, "[REDACTED]");
    assert.equal(limpio.monto, 100);
});

test("log(): un campo prohibido nunca llega a console.log aunque el caller lo mande por error", () => {
    const r = capturarLog(() => log("EXTERNAL_API_ERROR", { origen: "zapi", apiKey: "sb_secret_real_no_debe_salir" }));
    assert.equal(r.apiKey, "[REDACTED]");
    assert.equal(JSON.stringify(r).includes("sb_secret_real_no_debe_salir"), false);
});

test("evento fuera de la lista conocida -> igual loggea (con warning aparte), nunca revienta", () => {
    const r = capturarLog(() => log("EVENTO_INVENTADO", { x: 1 }));
    assert.equal(r.evento, "EVENTO_INVENTADO");
});

test("enmascararTelefono: teléfono corto (<=4) se deja igual, nunca revienta", () => {
    assert.equal(enmascararTelefono("123"), "123");
    assert.equal(enmascararTelefono(null), null);
    assert.equal(enmascararTelefono(undefined), null);
});

test("EVENTOS_VALIDOS contiene toda la taxonomía pedida", () => {
    const esperados = [
        "WEBHOOK_RECEIVED", "WEBHOOK_DUPLICATE", "WEBHOOK_REJECTED",
        "MESSAGE_PROCESSED", "OCR_SUCCESS", "OCR_FAILED",
        "OPERATION_CREATED", "OPERATION_CONFIRMED", "OPERATION_COMPLETED",
        "DELIVERY_CREATED", "DELIVERY_COMPLETED", "DELIVERY_INTERNAL_NOTIFICATION", "EXTERNAL_API_ERROR"
    ];
    for (const e of esperados) assert.ok(EVENTOS_VALIDOS.has(e), `falta ${e}`);
});
