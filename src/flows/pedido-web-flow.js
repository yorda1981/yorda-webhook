"use strict";

// ─────────────────────────────────────────────────────────
// PEDIDOS WEB (ENTREGA) — calculadora.html
//
// Cuando un cliente completa el flujo de la calculadora para
// una entrega en efectivo (CUP/USD) y presiona "Enviar pedido
// por WhatsApp", ese mensaje llega aquí como un mensaje normal
// de WhatsApp. Si tiene el formato esperado, se crea automáticamente
// como operación "pendiente" (con número) y el cliente recibe un
// acuse de recibo. Si el mensaje fue editado/incompleto, no se
// interpreta y sigue el flujo normal del bot (fallback seguro).
//
// Solo aplica a pedidos de ENTREGA (efectivo). Las transferencias
// (tarjeta) siguen el flujo conversacional normal, como hasta ahora.
// ─────────────────────────────────────────────────────────

const { agregarOperacion, buscarPorRefWeb } = require("../services/operations");
const { enviarSeguro } = require("./shared");

function esPedidoWebEntrega(texto) {
    if (!texto) return false;
    return /NUEVO PEDIDO|NOVO PEDIDO/i.test(texto) && texto.includes("🚚");
}

function limpiarNumero(s) {
    return Number(String(s || "").replace(/[^\d]/g, "")) || 0;
}

function parsearPedido(texto) {
    const ref         = (texto.match(/#([A-Za-z0-9]{4,14})/) || [])[1] || null;
    const totalMatch  = texto.match(/R\$\s*([\d.,]+)/);
    const recibeMatch = texto.match(/:\s*([\d.,]+)\s*(CUP|USD)\b/i);
    const nombre      = (texto.match(/👤[^:]*:\s*(.+)/) || [])[1];
    const direccion   = (texto.match(/🏠[^:]*:\s*(.+)/) || [])[1];
    const referencia  = (texto.match(/📌[^:]*:\s*(.+)/) || [])[1];
    const entregaTxt  = (texto.match(/🚚[^:]*:\s*(.+)/) || [])[1] || "";
    const pins        = [...texto.matchAll(/📍[^:]*:\s*(.+)/g)].map(m => m[1].trim());
    const telefonos   = [...texto.matchAll(/📞[^:]*:\s*(.+)/g)].map(m => m[1].trim());

    if (!totalMatch || !recibeMatch || !nombre || !direccion || pins.length < 2) return null;

    return {
        ref,
        monto:              limpiarNumero(totalMatch[1]),
        montoRecibe:         limpiarNumero(recibeMatch[1]),
        moneda:              recibeMatch[2].toUpperCase(),
        nombre:              nombre.trim(),
        telefono:            telefonos[0] || "",
        provincia:           pins[0],
        municipio:           pins[1],
        direccion:           direccion.trim(),
        referencia:          referencia ? referencia.trim() : "",
        entregaDisponible:   /^disponible|^dispon[ií]vel/i.test(entregaTxt.trim())
    };
}

async function procesarPedidoWebEntrega(phone, texto, pushName) {
    if (!esPedidoWebEntrega(texto)) return false;

    const esEs = /NUEVO PEDIDO/i.test(texto); // ES dice "NUEVO", PT dice "NOVO"
    const datos = parsearPedido(texto);
    if (!datos) return false; // mensaje editado/incompleto → sigue el flujo normal, sin romper nada

    // Evita duplicados si el cliente reenvía el mismo pedido
    if (datos.ref) {
        const existente = await buscarPorRefWeb(datos.ref);
        if (existente) {
            await enviarSeguro(phone, esEs
                ? `Ya tenemos tu pedido registrado ✅ (operación #${existente.id}). Lo estamos verificando.`
                : `Já temos seu pedido registrado ✅ (operação #${existente.id}). Estamos verificando.`
            );
            return true;
        }
    }

    const tipo = datos.moneda === "USD" ? "usd_efectivo" : "cup_efectivo";

    const operacion = await agregarOperacion({
        phone,
        nombre:  pushName || datos.nombre,
        monto:   datos.monto,
        cup:     datos.moneda === "CUP" ? datos.montoRecibe : 0,
        titular: datos.nombre,
        tipo,
        refWeb:            datos.ref,
        direccion:         datos.direccion,
        provincia:         datos.provincia,
        municipio:         datos.municipio,
        referenciaEntrega: datos.referencia,
        telefonoEntrega:   datos.telefono,
        entregaDisponible: datos.entregaDisponible
    });

    if (!operacion) return false;

    await enviarSeguro(phone, esEs
        ? `📩 Recibimos tu pedido #${operacion.id}. Lo estamos verificando, te avisamos en cuanto esté confirmado. 🇨🇺`
        : `📩 Recebemos seu pedido #${operacion.id}. Estamos verificando, avisamos assim que for confirmado. 🇨🇺`
    );
    return true;
}

module.exports = { esPedidoWebEntrega, procesarPedidoWebEntrega };
