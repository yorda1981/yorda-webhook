"use strict";

const entregas = require("./entregas");
const { enviarSeguro, destinatariosInternosEntregas, destinatariosInternosEntregasDetallados } = require("../flows/shared");
const { log, enmascararTelefono } = require("../utils/structured-logger");

// Único punto de finalización de una entrega de efectivo. La transición
// transaccional ocurre primero; si un retry/doble clic llega después,
// marcarEntregado devuelve null y no se emite ningún WhatsApp (ni al
// cliente ni el aviso interno de abajo).
async function finalizarEntrega(id, usuario, deps = {}) {
    const marcar = deps.marcarEntregado || entregas.marcarEntregado;
    const enviar = deps.enviarSeguro || enviarSeguro;
    const destinatariosInternos = deps.destinatariosInternosEntregas || destinatariosInternosEntregas;
    const destinatariosDetallados = deps.destinatariosInternosEntregasDetallados || destinatariosInternosEntregasDetallados;
    const entrega = await marcar(id, usuario);
    if (!entrega) return null;

    let notificado = false;
    try {
        const resultadoCliente = await enviar(entrega.phone, entregas.mensajeEntregaCompletadaCliente(entrega));
        notificado = resultadoCliente !== false;
    } catch (e) {
        console.error(`⚠️ No se pudo notificar entrega completada (cliente) ${entrega.codigo}:`, e.message);
    }

    // Aviso operativo interno (ADMIN_PHONE + ENTREGA_CONTACT_PHONE,
    // deduplicados por dígitos -- ver destinatariosInternosEntregas()).
    // Nunca va al cliente (entrega.phone) ni al receptor (telefono_entrega),
    // salvo que ese número esté configurado explícitamente como uno de los
    // dos destinatarios internos. Un fallo en un destinatario se registra y
    // no afecta al otro ni revierte la transición ya confirmada arriba.
    const lista = deps.destinatariosInternosEntregas
        ? destinatariosInternos().map((phone, index) => ({ phone, rol: index === 0 ? "ADMIN" : "ENTREGA_CONTACT" }))
        : destinatariosDetallados();
    for (const { phone: numero, rol } of lista) {
        try {
            const resultado = await enviar(numero, entregas.mensajeEntregaMarcada(entrega));
            if (resultado === false) throw new Error("Z-API devolvió fallo");
            log("DELIVERY_INTERNAL_NOTIFICATION", {
                entregaId: entrega.id,
                codigo: entrega.codigo,
                rol,
                phone: numero,
                resultado: "EXITO"
            });
        } catch (e) {
            log("DELIVERY_INTERNAL_NOTIFICATION", {
                entregaId: entrega.id,
                codigo: entrega.codigo,
                rol,
                phone: numero,
                resultado: "FALLO",
                error: e.message
            });
            console.error(`⚠️ No se pudo notificar entrega marcada (interno) ${entrega.codigo} a ${enmascararTelefono(numero)}:`, e.message);
        }
    }

    return { entrega, notificado };
}

module.exports = { finalizarEntrega };
