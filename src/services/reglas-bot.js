"use strict";

// ─────────────────────────────────────────────────────────
// REGLAS DEL BOT — funciones puras extraídas de los parches
// de src/services/openai.js
//
// Cada función de aquí es EXACTAMENTE la misma condición que
// ya vivía metida en el medio de procesarMensaje(), solo que
// ahora tiene nombre propio y se puede probar sola (ver
// test/reglas-bot.test.js) sin necesitar WhatsApp, base de
// datos, ni OpenAI reales.
//
// Estas funciones NO mandan mensajes ni tocan la base de
// datos — solo deciden SÍ/NO. openai.js sigue siendo el que
// hace las acciones (enviarSeguro, guardarCliente, etc.).
// ─────────────────────────────────────────────────────────

const ESTADOS_QUE_BLOQUEAN = ["aguardando_comprovante", "aguardando_numero_recarga"];

function clienteEstaOcupado(cliente) {
    return ESTADOS_QUE_BLOQUEAN.includes(cliente?.estado);
}

// FIX MENSAJE DUPLICADO — evita reenviar el PIX completo si el cliente
// manda la misma tarjeta varias veces seguidas mientras ya se espera el comprobante.
function esTarjetaDuplicada(cliente, tarjetaDetectada) {
    const yaGuardadaIgual = cliente?.tarjeta === tarjetaDetectada || cliente?.tarjeta_frecuente === tarjetaDetectada;
    const yaEsperandoComprobante = cliente?.estado === "aguardando_comprovante";
    return !!(yaGuardadaIgual && yaEsperandoComprobante && !cliente?.comprobante_pendiente);
}

// Consulta sobre entrega en efectivo / municipio — dispara la explicación +
// link de la calculadora solo si el cliente NO dio monto todavía y no está
// a mitad de un pago en curso.
function esConsultaEntrega(txt, montoValido, cliente) {
    const mencionaEntrega   = /entrega|entregan|entregar|domicilio|entregam/.test(txt);
    const mencionaEfectivo  = /efectivo|cash|dinheiro|espécie|especie/.test(txt);
    const mencionaMunicipio = /municipio|município/.test(txt);
    return !clienteEstaOcupado(cliente) && !montoValido && (mencionaEntrega || mencionaEfectivo || mencionaMunicipio);
}

// FIX 4 — un número solo ("200", sin la palabra "reales") también cuenta
// como monto válido para cotizar, siempre que el cliente no esté ocupado.
function esBareMontoValido(txt) {
    const soloNumeroTxt = txt.trim();
    const bareNumero = /^\d{2,5}$/.test(soloNumeroTxt) ? Number(soloNumeroTxt) : null;
    return bareNumero !== null && bareNumero >= 10 && bareNumero <= 50000 ? bareNumero : null;
}

// FIX 6 + FIX ENVÍO NUEVO SOBRE UNO ABANDONADO — decide si se puede cotizar
// un monto BRL nuevo. Si el cliente está "ocupado" con una operación vieja
// sin completar, solo se permite si el monto que menciona es DISTINTO al de
// esa operación vieja (en cuyo caso es un envío nuevo, no una continuación).
function esEnvioNuevoSobreAbandonado(cliente, montoValido, valorFinal) {
    return !!(
        clienteEstaOcupado(cliente) &&
        montoValido &&
        !cliente?.comprobante_pendiente &&
        Number(cliente?.ultimo_monto) !== valorFinal
    );
}

function puedeCotizarBRL(cliente, montoValido, valorFinal) {
    const ocupado = clienteEstaOcupado(cliente);
    if (!montoValido) return false;
    if (!ocupado) return true;
    return esEnvioNuevoSobreAbandonado(cliente, montoValido, valorFinal);
}

module.exports = {
    clienteEstaOcupado,
    esTarjetaDuplicada,
    esConsultaEntrega,
    esBareMontoValido,
    esEnvioNuevoSobreAbandonado,
    puedeCotizarBRL
};
