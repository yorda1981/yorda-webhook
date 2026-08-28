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
    clienteEstaOcupado,
    esRespuestaSoloMonto,
    debeCompletarConMontoPendiente,
    debeConfirmarCotizacion,
    tieneTarjetaGuardada,
    esRecarga,
    esConsultaTasas,
    esIntencionSinMonto
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

// ── debeCompletarConMontoPendiente (FIX LOOP parte 2) ──

test("cliente con comprobante+tarjeta ya recibidos, responde solo el monto -> completa directo", () => {
    const cliente = { comprobante_pendiente: true, tarjeta_frecuente: "9218123456789012" };
    assert.equal(debeCompletarConMontoPendiente(cliente, true, "300"), true);
    assert.equal(debeCompletarConMontoPendiente(cliente, true, "300 reales"), true);
});

test("mismo caso pero el mensaje NO es solo el monto (trae más texto) -> no completa así", () => {
    const cliente = { comprobante_pendiente: true, tarjeta_frecuente: "9218123456789012" };
    assert.equal(debeCompletarConMontoPendiente(cliente, true, "son 300 reales para mi mama"), false);
});

test("sin comprobante pendiente -> no aplica este atajo", () => {
    const cliente = { comprobante_pendiente: false, tarjeta_frecuente: "9218123456789012" };
    assert.equal(debeCompletarConMontoPendiente(cliente, true, "300"), false);
});

test("sin tarjeta guardada -> no aplica este atajo (falta info)", () => {
    const cliente = { comprobante_pendiente: true };
    assert.equal(debeCompletarConMontoPendiente(cliente, true, "300"), false);
});

// ── debeConfirmarCotizacion / tieneTarjetaGuardada (FIX 5) ──

test("'dale' tras cotizar, sin monto nuevo -> confirma", () => {
    const cliente = { estado: "cotizacion_realizada" };
    assert.equal(debeConfirmarCotizacion(cliente, true, false), true);
});

test("'quiero 200 reales' (trae monto nuevo) -> NO confirma, debe cotizar ese monto", () => {
    const cliente = { estado: "cotizacion_realizada" };
    assert.equal(debeConfirmarCotizacion(cliente, true, true), false);
});

test("confirma pero el cliente NO tiene tarjeta guardada -> hay que pedirla antes", () => {
    assert.equal(tieneTarjetaGuardada({}), false);
    assert.equal(tieneTarjetaGuardada({ tarjeta: "9218123456789012" }), true);
    assert.equal(tieneTarjetaGuardada({ tarjeta_frecuente: "9218123456789012" }), true);
});

// ── esRespuestaSoloMonto ──

test("reconoce distintos formatos de 'solo un monto'", () => {
    assert.equal(esRespuestaSoloMonto("300"), true);
    assert.equal(esRespuestaSoloMonto("R$300"), true);
    assert.equal(esRespuestaSoloMonto("300 reales"), true);
    assert.equal(esRespuestaSoloMonto("300,50"), true);
});

test("no confunde un mensaje con más contexto como 'solo un monto'", () => {
    assert.equal(esRespuestaSoloMonto("son 300 para mi mama"), false);
    assert.equal(esRespuestaSoloMonto("hola"), false);
});

// ── esRecarga (bug viejo: mostraba "0 CUP" en recargas) ──

test("recarga_nacional -> es recarga", () => {
    assert.equal(esRecarga({ tipo_favorito: "recarga_nacional" }), true);
});

test("recarga_internacional -> es recarga", () => {
    assert.equal(esRecarga({ tipo_favorito: "recarga_internacional" }), true);
});

test("brl_cup (remesa normal) -> NO es recarga", () => {
    assert.equal(esRecarga({ tipo_favorito: "brl_cup" }), false);
});

test("sin tipo_favorito / cliente vacío -> NO es recarga, no revienta", () => {
    assert.equal(esRecarga({}), false);
    assert.equal(esRecarga(null), false);
    assert.equal(esRecarga(undefined), false);
});

// ── esConsultaTasas / esIntencionSinMonto (bug: cliente en portugués sin respuesta) ──

function norm(s) { return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }

test("PT: 'Posso passar reais' -> se reconoce como intención de enviar", () => {
    assert.equal(esIntencionSinMonto(norm("Posso passar reais")), true);
});

test("PT: 'Qual o valor do cup' -> se reconoce como consulta de tasas", () => {
    assert.equal(esConsultaTasas(norm("Qual o valor do cup")), true);
});

test("PT: 'Quero enviar dinheiro' -> se reconoce como intención de enviar", () => {
    assert.equal(esIntencionSinMonto(norm("Quero enviar dinheiro")), true);
});

test("PT: 'Quanto está a taxa hoje' -> se reconoce como consulta de tasas", () => {
    assert.equal(esConsultaTasas(norm("Quanto está a taxa hoje")), true);
});

test("ES: las frases originales en español siguen funcionando (no se rompió nada)", () => {
    assert.equal(esIntencionSinMonto(norm("Quiero enviar dinero")), true);
    assert.equal(esConsultaTasas(norm("A cuanto esta hoy")), true);
});

test("mensaje ambiguo sin intención clara ('Ainda não') -> no dispara ninguna de las dos (correcto, no es un pedido)", () => {
    assert.equal(esIntencionSinMonto(norm("Ainda nao")), false);
    assert.equal(esConsultaTasas(norm("Ainda nao")), false);
});
