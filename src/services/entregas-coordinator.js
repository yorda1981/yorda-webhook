"use strict";

const entregas = require("./entregas");
const { enviarSeguro, destinatariosInternosEntregas, destinatariosInternosEntregasDetallados } = require("../flows/shared");
const { log, enmascararTelefono } = require("../utils/structured-logger");

function mensajeComprobantePago(resultado) {
    const pago = resultado?.pago || {};
    const entregasPagadas = Array.isArray(resultado?.entregas) ? resultado.entregas : [];
    const codigos = entregasPagadas.map(e => e.codigo).join(", ") || "—";
    return `💵 *COMPROBANTE DE PAGO ${pago.codigo || "—"}*\n\n` +
        `📅 *Fecha:* ${pago.fecha || "—"}\n` +
        `📦 *Entregas:* ${codigos}\n` +
        `🔢 *Cantidad:* ${entregasPagadas.length}\n` +
        `📊 *Subtotal entregas:* ${pago.subtotal_usdt} USDT\n` +
        `🚚 *Frete:* ${pago.frete_usdt} USDT\n` +
        `💰 *TOTAL PAGADO:* ${pago.total_usdt} USDT\n\n` +
        `Estado: PAGADO`;
}

async function notificarComprobantePago(resultado, deps = {}) {
    const enviar = deps.enviarSeguro || enviarSeguro;
    const detallados = deps.destinatariosInternosEntregasDetallados || destinatariosInternosEntregasDetallados;
    if (resultado?.pago?.subtotal_usdt == null || resultado?.pago?.total_usdt == null) {
        console.warn(`⚠️ No se envía comprobante desglosado para pago histórico ${resultado?.pago?.codigo || "—"}`);
        return;
    }
    const mensaje = mensajeComprobantePago(resultado);
    for (const { phone, rol } of detallados()) {
        try {
            const ok = await enviar(phone, mensaje);
            if (ok === false) throw new Error("Z-API devolvió fallo");
            log("DELIVERY_PAYMENT_RECEIPT", {
                pagoId: resultado?.pago?.id,
                codigo: resultado?.pago?.codigo,
                rol,
                phone,
                resultado: "EXITO"
            });
        } catch (e) {
            log("DELIVERY_PAYMENT_RECEIPT", {
                pagoId: resultado?.pago?.id,
                codigo: resultado?.pago?.codigo,
                rol,
                phone,
                resultado: "FALLO",
                error: e.message
            });
            console.error(`⚠️ No se pudo enviar comprobante de pago ${resultado?.pago?.codigo || "—"} a ${enmascararTelefono(phone)}:`, e.message);
        }
    }
}

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

module.exports = { finalizarEntrega, mensajeComprobantePago, notificarComprobantePago };
