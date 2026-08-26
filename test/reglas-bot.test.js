"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — reglas del bot (src/services/reglas-bot.js)
//
// Cómo correrlas:   node --test test/reglas-bot.test.js
// (o simplemente:   node --test     — corre todos los archivos *.test.js)
//
// No necesitan base de datos, WhatsApp, ni OpenAI reales — prueban
// solo las funciones de DECISIÓN puras. Si algún cambio futuro en
// reglas-bot.js rompe alguno de estos casos, esto lo va a detectar
// antes de subir a producción.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    esTarjetaDuplicada,
    esConsultaEntrega,
    esBareMontoValido,
    esEnvioNuevoSobreAbandonado,
    puedeCotizarBRL,
    clienteEstaOcupado
} = require("../src/services/reglas-bot");

// ── esTarjetaDuplicada (Bug: "método de pago" repetido) ──

test("tarjeta repetida mientras se espera comprobante -> NO reenvía", () => {
    const cliente = { tarjeta: "9218123456789012", tarjeta_frecuente: "9218123456789012", estado: "aguardando_comprovante", comprobante_pendiente: false };
    assert.equal(esTarjetaDuplicada(cliente, "9218123456789012"), true);
});

test("tarjeta DISTINTA a la guardada (cliente se corrige) -> SÍ procesa", () => {
    const cliente = { tarjeta: "1111222233334444", tarjeta_frecuente: "1111222233334444", estado: "aguardando_comprovante", comprobante_pendiente: false };
    assert.equal(esTarjetaDuplicada(cliente, "9999888877776666"), false);
});

test("misma tarjeta pero SIN estar esperando comprobante -> no es duplicado", () => {
    const cliente = { tarjeta: "9218123456789012", estado: "cotizacion_realizada" };
    assert.equal(esTarjetaDuplicada(cliente, "9218123456789012"), false);
});

test("misma tarjeta pero con comprobante YA recibido en proceso -> no bloquear", () => {
    const cliente = { tarjeta: "9218123456789012", estado: "aguardando_comprovante", comprobante_pendiente: true };
    assert.equal(esTarjetaDuplicada(cliente, "9218123456789012"), false);
});

// ── esEnvioNuevoSobreAbandonado / puedeCotizarBRL (Bug: reaparece el envío anterior) ──

test("cliente con operación abandonada (300) pide un monto NUEVO (500) -> se permite cotizar", () => {
    const cliente = { estado: "aguardando_comprovante", ultimo_monto: 300, comprobante_pendiente: false };
    assert.equal(esEnvioNuevoSobreAbandonado(cliente, true, 500), true);
    assert.equal(puedeCotizarBRL(cliente, true, 500), true);
});

test("cliente con operación abandonada (300) repite el MISMO monto (300) -> sigue como la misma operación", () => {
    const cliente = { estado: "aguardando_comprovante", ultimo_monto: 300, comprobante_pendiente: false };
    assert.equal(esEnvioNuevoSobreAbandonado(cliente, true, 300), false);
    assert.equal(puedeCotizarBRL(cliente, true, 300), false);
});

test("cliente con comprobante YA recibido en proceso -> nunca resetear aunque cambie el monto", () => {
    const cliente = { estado: "aguardando_comprovante", ultimo_monto: 300, comprobante_pendiente: true };
    assert.equal(esEnvioNuevoSobreAbandonado(cliente, true, 500), false);
});

test("cliente libre (sin estado bloqueante) con monto válido -> siempre puede cotizar", () => {
    const cliente = { estado: "cotizacion_realizada", ultimo_monto: 300 };
    assert.equal(puedeCotizarBRL(cliente, true, 500), true);
});

test("monto inválido -> nunca cotiza, esté ocupado o no", () => {
    assert.equal(puedeCotizarBRL({ estado: "cotizacion_realizada" }, false, 500), false);
    assert.equal(puedeCotizarBRL({ estado: "aguardando_comprovante" }, false, 500), false);
});

// ── esConsultaEntrega (explicación de entrega + link calculadora) ──

test("pregunta por entrega en efectivo -> dispara explicación", () => {
    assert.equal(esConsultaEntrega("hacen entrega en efectivo?", false, {}), true);
});

test("pregunta por municipios de entrega -> dispara explicación", () => {
    assert.equal(esConsultaEntrega("en que municipios entregan", false, {}), true);
});

test("pregunta en portugués sobre entrega en dinheiro -> dispara explicación", () => {
    assert.equal(esConsultaEntrega("vocês entregam em dinheiro?", false, {}), true);
});

test("ya viene con monto ('quiero enviar 500 en efectivo') -> NO interrumpe con la explicación, va a cotizar", () => {
    assert.equal(esConsultaEntrega("quiero enviar 500 reales en efectivo", true, {}), false);
});

test("cliente ocupado (esperando comprobante) -> no lo interrumpe con la explicación", () => {
    const cliente = { estado: "aguardando_comprovante" };
    assert.equal(esConsultaEntrega("entrega en efectivo", false, cliente), false);
});

test("mensaje sin relación a entrega/efectivo/municipio -> no dispara", () => {
    assert.equal(esConsultaEntrega("hola como estas", false, {}), false);
});

// ── esBareMontoValido (FIX 4: número solo) ──

test("número solo dentro de rango (10-50000) -> monto válido", () => {
    assert.equal(esBareMontoValido("200"), 200);
});

test("número fuera de rango -> null", () => {
    assert.equal(esBareMontoValido("5"), null);
    assert.equal(esBareMontoValido("999999"), null);
});

test("texto que no es un número aislado -> null", () => {
    assert.equal(esBareMontoValido("200 reales"), null);
    assert.equal(esBareMontoValido("hola"), null);
});

// ── clienteEstaOcupado (helper compartido) ──

test("estados que bloquean: aguardando_comprovante y aguardando_numero_recarga", () => {
    assert.equal(clienteEstaOcupado({ estado: "aguardando_comprovante" }), true);
    assert.equal(clienteEstaOcupado({ estado: "aguardando_numero_recarga" }), true);
    assert.equal(clienteEstaOcupado({ estado: "cotizacion_realizada" }), false);
    assert.equal(clienteEstaOcupado(null), false);
    assert.equal(clienteEstaOcupado(undefined), false);
});
