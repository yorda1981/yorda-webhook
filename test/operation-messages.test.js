"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — mensajes de confirmar/completar operación
// (src/services/operation-messages.js), extraídas de index.js para poder
// probarlas sin levantar el servidor.
//
// Objetivo central: una operación de recarga NUNCA debe redactarse como
// "tu transferencia fue completada", y una transferencia/entrega real
// NUNCA debe verse afectada por la nueva rama de recargas.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const { mensajeConfirmarOperacion, mensajeCompletarOperacion } = require("../src/services/operation-messages");

test("mensajeCompletarOperacion: transferencia normal -> 'tu transferencia fue completada', sin mención de recarga", () => {
    const m = mensajeCompletarOperacion({ tipo: "brl_cup", monto: 100 });
    assert.match(m, /tu transferencia fue completada/i);
    assert.doesNotMatch(m, /recarga/i);
});

test("mensajeCompletarOperacion: entrega en efectivo -> 'tu entrega fue completada'", () => {
    const m = mensajeCompletarOperacion({ tipo: "cup_efectivo", monto: 100 });
    assert.match(m, /tu entrega fue completada/i);
    assert.doesNotMatch(m, /transferencia|recarga/i);
});

test("mensajeCompletarOperacion: recarga_nacional -> 'tu recarga Nacional fue completada', nunca 'transferencia'", () => {
    const m = mensajeCompletarOperacion({ tipo: "recarga_nacional", monto: 100 });
    assert.match(m, /tu recarga Nacional fue completada/i);
    assert.doesNotMatch(m, /transferencia/i);
});

test("mensajeCompletarOperacion: recarga_internacional -> dice 'Internacional', nunca hardcodea 'Nacional'", () => {
    const m = mensajeCompletarOperacion({ tipo: "recarga_internacional", monto: 145 });
    assert.match(m, /tu recarga Internacional fue completada/i);
    assert.doesNotMatch(m, /\bNacional\b/);
    assert.doesNotMatch(m, /transferencia/i);
});

test("mensajeConfirmarOperacion: recarga -> 'Procederemos a realizar tu recarga', sin la nota de plazo de 48h (esa es de entregas)", () => {
    const m = mensajeConfirmarOperacion({ tipo: "recarga_internacional", monto: 145 });
    assert.match(m, /Procederemos a realizar tu recarga/i);
    assert.doesNotMatch(m, /48 horas/);
});

test("mensajeConfirmarOperacion: entrega en efectivo -> incluye la nota de plazo de 48h", () => {
    const m = mensajeConfirmarOperacion({ tipo: "usd_efectivo", monto: 50 });
    assert.match(m, /coordinar su entrega en Cuba/i);
    assert.match(m, /48 horas/);
});

test("mensajeConfirmarOperacion: transferencia normal -> texto genérico sin mención de recarga/entrega", () => {
    const m = mensajeConfirmarOperacion({ tipo: "brl_usd", monto: 200 });
    assert.match(m, /realizar la transferencia a Cuba/i);
    assert.doesNotMatch(m, /recarga|entrega/i);
});
