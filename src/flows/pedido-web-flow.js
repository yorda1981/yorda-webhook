"use strict";

// ─────────────────────────────────────────────────────────
// PEDIDOS WEB — calculadora.html
//
// Cuando un cliente completa el flujo de la calculadora (entrega
// en efectivo O transferencia) y presiona "Enviar pedido por
// WhatsApp", ese mensaje llega aquí como un mensaje normal de
// WhatsApp. Si tiene el formato esperado, se crea automáticamente
// como operación "pendiente" (con número) y el cliente recibe un
// acuse de recibo. Si el mensaje fue editado/incompleto, no se
// interpreta y sigue el flujo normal del bot (fallback seguro).
// ─────────────────────────────────────────────────────────

const { agregarOperacion, buscarPorRefWeb } = require("../services/operations");
const { enviarSeguro } = require("./shared");

function esPedidoWeb(texto) {
    if (!texto) return false;
    return /NUEVO PEDIDO|NOVO PEDIDO/i.test(texto);
}

function esEntrega(texto) {
    return texto.includes("🚚");
}

function limpiarNumero(s) {
    return Number(String(s || "").replace(/[^\d]/g, "")) || 0;
}

// ── ENTREGA (efectivo) ──────────────────────────────────

function parsearPedidoEntrega(texto) {
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

async function manejarEntrega(phone, texto, pushName, esEs) {
    const datos = parsearPedidoEntrega(texto);
    if (!datos) return false; // mensaje editado/incompleto → sigue el flujo normal, sin romper nada

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

// ── TRANSFERENCIA (tarjeta/cuenta) ──────────────────────

function parsearPedidoTransferencia(texto) {
    const ref          = (texto.match(/#([A-Za-z0-9]{4,14})/) || [])[1] || null;
    const totalMatch   = texto.match(/R\$\s*([\d.,]+)/);
    const recibeMatch  = texto.match(/:\s*([\d.,]+)\s*(CUP|USD|MLC)\b/i);
    // Ojo: el emoji 💳 también aparece en la línea final "💳 Pago: PIX",
    // pero la línea de tarjeta/cuenta siempre va PRIMERO en el mensaje,
    // así que match() (que devuelve la primera coincidencia) toma la correcta.
    const tarjetaMatch = texto.match(/💳[^:]*:\s*(.+)/);
    const banco        = (texto.match(/🏦[^:]*:\s*(.+)/) || [])[1];
    const nombreBenef  = (texto.match(/👤[^:]*:\s*(.+)/) || [])[1];
    const telefono     = (texto.match(/📞[^:]*:\s*(.+)/) || [])[1];

    if (!totalMatch || !recibeMatch || !tarjetaMatch) return null;

    const tarjeta = tarjetaMatch[1].trim();
    // Validación extra de seguridad: si por algún motivo se capturó otra cosa
    // (ej. el cliente borró la línea de tarjeta y esto agarró "PIX" de otra línea),
    // exigimos que sean exactamente 16 dígitos — igual que valida la calculadora.
    if (!/^\d{16}$/.test(tarjeta)) return null;

    return {
        ref,
        monto:       limpiarNumero(totalMatch[1]),
        montoRecibe: limpiarNumero(recibeMatch[1]),
        moneda:      recibeMatch[2].toUpperCase(),
        tarjeta,
        banco:       banco ? banco.trim() : "",
        nombreBenef: nombreBenef ? nombreBenef.trim() : "",
        telefono:    telefono ? telefono.trim() : ""
    };
}

async function manejarTransferencia(phone, texto, pushName, esEs) {
    const datos = parsearPedidoTransferencia(texto);
    if (!datos) return false; // mensaje editado/incompleto → sigue el flujo normal, sin romper nada

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

    const tipoPorMoneda = { CUP: "cup_transferencia", USD: "usd_transferencia", MLC: "mlc_transferencia" };
    const tipo = tipoPorMoneda[datos.moneda] || "cup_transferencia";

    const operacion = await agregarOperacion({
        phone,
        nombre:  pushName || datos.nombreBenef || "Cliente",
        monto:   datos.monto,
        cup:     datos.moneda === "CUP" ? datos.montoRecibe : 0,
        tarjeta: datos.tarjeta,
        titular: datos.nombreBenef,
        banco:   datos.banco,
        tipo,
        refWeb:  datos.ref
    });

    if (!operacion) return false;

    await enviarSeguro(phone, esEs
        ? `📩 Recibimos tu pedido #${operacion.id}. Lo estamos verificando, te avisamos en cuanto esté confirmado. 🇨🇺`
        : `📩 Recebemos seu pedido #${operacion.id}. Estamos verificando, avisamos assim que for confirmado. 🇨🇺`
    );
    return true;
}

// ── ENTRADA ÚNICA ────────────────────────────────────────

async function procesarPedidoWeb(phone, texto, pushName) {
    if (!esPedidoWeb(texto)) return false;

    const esEs = /NUEVO PEDIDO/i.test(texto); // ES dice "NUEVO", PT dice "NOVO"

    if (esEntrega(texto)) {
        return await manejarEntrega(phone, texto, pushName, esEs);
    }
    return await manejarTransferencia(phone, texto, pushName, esEs);
}

module.exports = { esPedidoWeb, procesarPedidoWeb };
