"use strict";

const entregas = require("./entregas");
const { enviarSeguro } = require("../flows/shared");

// Único punto de finalización de una entrega de efectivo. La transición
// transaccional ocurre primero; si un retry/doble clic llega después,
// marcarEntregado devuelve null y no se emite otro WhatsApp.
async function finalizarEntrega(id, usuario, deps = {}) {
    const marcar = deps.marcarEntregado || entregas.marcarEntregado;
    const enviar = deps.enviarSeguro || enviarSeguro;
    const entrega = await marcar(id, usuario);
    if (!entrega) return null;

    let notificado = false;
    try {
        await enviar(entrega.phone, entregas.mensajeEntregaCompletadaCliente(entrega));
        notificado = true;
    } catch (e) {
        console.error(`⚠️ No se pudo notificar entrega completada ${entrega.codigo}:`, e.message);
    }
    return { entrega, notificado };
}

module.exports = { finalizarEntrega };
