"use strict";

// ─────────────────────────────────────────────────────────
// MENSAJES DE CONFIRMAR/COMPLETAR OPERACIÓN — funciones puras extraídas
// de index.js (mismo patrón que src/services/reglas-bot.js) para poder
// probarlas sin levantar el servidor Express.
//
// Una operación de recarga (tipo = "recarga_nacional"/"recarga_internacional")
// NUNCA debe redactarse como "tu transferencia fue completada" -- y nunca se
// hardcodea "Nacional": el texto sale del tipo REAL de la operación.
// ─────────────────────────────────────────────────────────

function esEntregaEfectivo(operacion) {
    return operacion?.tipo === "cup_efectivo" || operacion?.tipo === "usd_efectivo";
}

function esOperacionDeRecarga(operacion) {
    return typeof operacion?.tipo === "string" && operacion.tipo.startsWith("recarga_");
}

function etiquetaModalidadRecarga(operacion) {
    const tipoRecargaKey = operacion.tipo.replace("recarga_", "");
    return tipoRecargaKey === "nacional" ? "Nacional" : "Internacional";
}

// Mensaje al CONFIRMAR (pago verificado, todavía no se completó el servicio).
function mensajeConfirmarOperacion(operacion) {
    let cuerpo;
    if (esOperacionDeRecarga(operacion)) cuerpo = "Procederemos a realizar tu recarga.";
    else if (esEntregaEfectivo(operacion)) cuerpo = "Procederemos a coordinar su entrega en Cuba.";
    else cuerpo = "Procederemos a realizar la transferencia a Cuba.";

    const notaPlazo = esEntregaEfectivo(operacion)
        ? "\n\n🚚 Recuerda: la entrega puede demorar hasta 48 horas, según la demanda y disponibilidad."
        : "";

    return `✅ Recibimos su pago de R$${operacion.monto}.\n\n${cuerpo}\n\nCuando se complete le enviaremos el comprobante. 😊${notaPlazo}`;
}

// Mensaje al COMPLETAR (servicio ya realizado).
function mensajeCompletarOperacion(operacion) {
    if (esOperacionDeRecarga(operacion)) {
        const label = etiquetaModalidadRecarga(operacion);
        return `🎉 ¡Tu recarga ${label} fue completada con éxito! Gracias por preferir nuestros servicios. 🇨🇺💜`;
    }
    if (esEntregaEfectivo(operacion)) {
        return "🎉 ¡Tu entrega fue completada con éxito! Gracias por preferir nuestros servicios. 🇨🇺💜";
    }
    return "🎉 ¡Tu transferencia fue completada con éxito! Gracias por preferir nuestros servicios. 🇨🇺💜";
}

module.exports = {
    esEntregaEfectivo,
    esOperacionDeRecarga,
    mensajeConfirmarOperacion,
    mensajeCompletarOperacion
};
