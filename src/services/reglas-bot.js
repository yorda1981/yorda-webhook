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

// FIX LOOP (parte 2) — comprobante + tarjeta ya recibidos, solo faltaba el monto.
// Si el texto es SOLO un número (con o sin "reales"/"r$"), se cierra la operación
// directo en vez de volver a cotizar.
function esRespuestaSoloMonto(text) {
    return /^\s*r?\$?\s*\d{1,6}([.,]\d{1,2})?\s*(reales|reais|brl|r\$)?\s*$/i.test(text || "");
}

function debeCompletarConMontoPendiente(cliente, montoValido, text) {
    return !!(
        cliente?.comprobante_pendiente &&
        (cliente?.tarjeta || cliente?.tarjeta_frecuente) &&
        montoValido &&
        esRespuestaSoloMonto(text)
    );
}

// FIX 5 — "quiero 200 reales" no debe confirmar la cotización anterior, debe
// cotizar el monto nuevo. Solo se trata como confirmación si NO viene un monto.
function debeConfirmarCotizacion(cliente, esConfirma, montoValido) {
    return !!(esConfirma && cliente?.estado === "cotizacion_realizada" && !montoValido);
}

function tieneTarjetaGuardada(cliente) {
    return !!(cliente?.tarjeta || cliente?.tarjeta_frecuente);
}

// BUG VIEJO: esRecarga comparaba contra "recarga_etecsa" (que nunca se guarda de
// verdad) en vez de "recarga_nacional" / "recarga_internacional" — por eso las
// recargas se trataban como remesa normal y el mensaje mostraba "Recibe: 0 CUP".
function esRecarga(cliente) {
    return !!cliente?.tipo_favorito?.startsWith("recarga_");
}

// BUG VIEJO: estas 2 reglas solo reconocían frases en español — un cliente que
// escribía en portugués ("Posso passar reais", "Qual o valor do cup") no coincidía
// con ninguna regla y el mensaje caía en la IA de respaldo, que a veces decidía
// quedarse en silencio. Se agregaron los equivalentes en portugués.
function esConsultaTasas(txt) {
    return /a cuanto|a como|tasa.*hoy|cambio.*hoy|hoy.*cambio|hoy.*tasa|cual es la tasa|como esta el cambio|como esta la tasa|cuanto vale|cuanto esta|precio.*hoy|hoy.*precio|tasa de hoy|cambio de hoy|qual o valor|qual a taxa|quanto esta|quanto está|quanto vale|taxa de hoje|cambio de hoje|hoje.*taxa|taxa.*hoje/.test(txt);
}

function esIntencionSinMonto(txt) {
    return /quiero enviar|necesito enviar|quiero mandar|quiero hacer (una )?(remesa|transferencia)|necesito (una )?(remesa|transferencia)|posso (enviar|mandar|passar)|quero enviar|quero mandar|preciso enviar|quero fazer (uma )?(remessa|transferencia)|preciso (fazer )?(uma )?(remessa|transferencia)/.test(txt);
}

module.exports = {
    clienteEstaOcupado,
    esTarjetaDuplicada,
    esConsultaEntrega,
    esBareMontoValido,
    esEnvioNuevoSobreAbandonado,
    puedeCotizarBRL,
    esRespuestaSoloMonto,
    debeCompletarConMontoPendiente,
    debeConfirmarCotizacion,
    tieneTarjetaGuardada,
    esRecarga,
    esConsultaTasas,
    esIntencionSinMonto
};
