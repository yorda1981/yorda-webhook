"use strict";

const entregas = require("./entregas");
const { enviarSeguro, destinatariosInternosEntregas } = require("../flows/shared");

// Único punto de finalización de una entrega de efectivo. La transición
// transaccional ocurre primero; si un retry/doble clic llega después,
// marcarEntregado devuelve null y no se emite ningún WhatsApp (ni al
// cliente ni el aviso interno de abajo).
async function finalizarEntrega(id, usuario, deps = {}) {
    const marcar = deps.marcarEntregado || entregas.marcarEntregado;
    const enviar = deps.enviarSeguro || enviarSeguro;
    const destinatariosInternos = deps.destinatariosInternosEntregas || destinatariosInternosEntregas;
    const entrega = await marcar(id, usuario);
    if (!entrega) return null;

    let notificado = false;
    try {
        await enviar(entrega.phone, entregas.mensajeEntregaCompletadaCliente(entrega));
        notificado = true;
    } catch (e) {
        console.error(`⚠️ No se pudo notificar entrega completada (cliente) ${entrega.codigo}:`, e.message);
    }

    // Aviso operativo interno (ADMIN_PHONE + ENTREGA_CONTACT_PHONE,
    // deduplicados por dígitos -- ver destinatariosInternosEntregas()).
    // Nunca va al cliente (entrega.phone) ni al receptor (telefono_entrega),
    // salvo que ese número esté configurado explícitamente como uno de los
    // dos destinatarios internos. Un fallo en un destinatario se registra y
    // no afecta al otro ni revierte la transición ya confirmada arriba.
    for (const numero of destinatariosInternos()) {
        try {
            await enviar(numero, entregas.mensajeEntregaMarcada(entrega));
        } catch (e) {
            console.error(`⚠️ No se pudo notificar entrega marcada (interno) ${entrega.codigo} a ${numero}:`, e.message);
        }
    }

    return { entrega, notificado };
}

module.exports = { finalizarEntrega };
