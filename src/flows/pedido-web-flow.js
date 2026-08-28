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

const pool = require("../../db");
const { agregarOperacion, buscarPorRefWeb } = require("../services/operations");
const { guardarCliente } = require("../services/customer-memory");
const { enviarSeguro } = require("./shared");

// Consulta el nivel VIP (0-3) de este teléfono (para el descuento de entrega escalado).
async function nivelVipDe(phone) {
    try {
        const r = await pool.query("SELECT nivel_vip FROM customers WHERE phone = $1", [phone]);
        return Number(r.rows[0]?.nivel_vip || 0);
    } catch { return 0; }
}

// Trae de una sola vez toda la configuración VIP de la tabla `rates`.
async function obtenerConfigVip() {
    try {
        const r = await pool.query(`
            SELECT tarifa_entrega,
                   bono_vip_1, bono_vip_2, bono_vip_3,
                   descuento_entrega_1, descuento_entrega_2, descuento_entrega_3
            FROM rates LIMIT 1
        `);
        return r.rows[0] || {};
    } catch { return {}; }
}

function bonoVipPara(nivel, cfg) {
    return nivel === 3 ? Number(cfg.bono_vip_3 || 0)
        : nivel === 2 ? Number(cfg.bono_vip_2 || 0)
        : nivel === 1 ? Number(cfg.bono_vip_1 || 0)
        : 0;
}

function descuentoEntregaPctPara(nivel, cfg) {
    return nivel === 3 ? Number(cfg.descuento_entrega_3 || 0)
        : nivel === 2 ? Number(cfg.descuento_entrega_2 || 0)
        : Number(cfg.descuento_entrega_1 || 0);
}

// Oferta exclusiva VIP (la misma que se usa en las cotizaciones directas por WhatsApp).
async function obtenerOfertaVip() {
    try {
        const r = await pool.query("SELECT texto_vip, activa_vip FROM ofertas LIMIT 1");
        const row = r.rows[0];
        if (row && row.activa_vip && row.texto_vip) return row.texto_vip;
        return null;
    } catch { return null; }
}

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

    // Beneficios VIP: la calculadora no sabe quién es el cliente (es anónima), así
    // que el total y el monto que llegan en el mensaje son los del precio SIN ningún
    // beneficio VIP. Acá, con el teléfono real de WhatsApp, sí sabemos si es VIP —
    // se recalculan aquí antes de guardar la operación, y se avisa en el mensaje.
    let montoRecibeFinal = datos.montoRecibe;
    let notaVip = "";
    const nivel = await nivelVipDe(phone);

    // "datos.monto" incluye la tarifa de entrega — la separamos para saber cuánto
    // es el costo real del cambio (necesario para calcular el bono de tasa aparte
    // del descuento de entrega, que son dos cosas distintas).
    let tarifaEnEsteMonto = 0;
    let costoOperacionFinal = datos.monto;

    if (nivel > 0) {
        try {
            const cfg = await obtenerConfigVip();
            const tarifa = Number(cfg.tarifa_entrega || 0);
            const costoOperacionOriginal = Math.max(0, datos.monto - tarifa);
            let entregaFinal = tarifa;
            costoOperacionFinal = costoOperacionOriginal;
            const notas = [];

            // 1) Descuento de entrega, escalado por nivel
            const descPct = descuentoEntregaPctPara(nivel, cfg);
            const descuentoEntrega = Math.round(tarifa * descPct / 100);
            if (descuentoEntrega > 0) {
                entregaFinal = Math.max(0, entregaFinal - descuentoEntrega);
                notas.push(esEs ? `${descPct}% de descuento en la entrega` : `${descPct}% de desconto na entrega`);
            }
            tarifaEnEsteMonto = entregaFinal;

            // 2) Bono de tasa (CUP extra) — solo aplica cuando se recibe en CUP
            const bono = bonoVipPara(nivel, cfg);
            if (bono > 0 && datos.moneda === "CUP" && costoOperacionOriginal > 0) {
                const cupExtra = Math.floor(costoOperacionOriginal * bono);
                if (cupExtra > 0) {
                    montoRecibeFinal += cupExtra;
                    notas.push(esEs ? `${cupExtra} CUP extra por tu tasa VIP` : `${cupExtra} CUP extra pela sua taxa VIP`);
                }
            }

            if (notas.length) {
                const estrellas = "⭐".repeat(nivel);
                notaVip = esEs
                    ? `\n\n${estrellas} Beneficios VIP aplicados: ${notas.join(" + ")}.`
                    : `\n\n${estrellas} Benefícios VIP aplicados: ${notas.join(" + ")}.`;
            }

            // 3) Promo exclusiva VIP
            const oferta = await obtenerOfertaVip();
            if (oferta) notaVip += `\n\n🔥 ${oferta}`;
        } catch (e) {
            console.error("❌ Error aplicando beneficios VIP (entrega):", e.message);
            costoOperacionFinal = datos.monto; // si algo falla, seguimos con el monto original sin arriesgar
            tarifaEnEsteMonto = 0;
        }
    }

    const montoFinal = nivel > 0 ? (costoOperacionFinal + tarifaEnEsteMonto) : datos.monto;

    const operacion = await agregarOperacion({
        phone,
        nombre:  pushName || datos.nombre,
        monto:   montoFinal,
        cup:     datos.moneda === "CUP" ? montoRecibeFinal : 0,
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

    // Marca al cliente para que el bot conversacional se quede en silencio si
    // manda algo más (ver el guard en openai.js) — este pedido ya se maneja
    // 100% desde el dashboard, no necesita que el bot intervenga.
    await guardarCliente({ phone, estado: "pedido_web_pendiente" });

    await enviarSeguro(phone, esEs
        ? `📩 Recibimos tu pedido #${operacion.id}. Lo estamos verificando, te avisamos en cuanto esté confirmado. 🇨🇺${notaVip}`
        : `📩 Recebemos seu pedido #${operacion.id}. Estamos verificando, avisamos assim que for confirmado. 🇨🇺${notaVip}`
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

    // Beneficio VIP: bono de tasa (CUP extra) + promo exclusiva.
    // No hay tarifa de entrega en transferencia, así que es más simple que en efectivo.
    let montoRecibeFinal = datos.montoRecibe;
    let notaVip = "";
    const nivel = await nivelVipDe(phone);

    if (nivel > 0) {
        try {
            const notas = [];
            const cfg = await obtenerConfigVip();
            const bono = bonoVipPara(nivel, cfg);

            if (bono > 0 && datos.moneda === "CUP" && datos.monto > 0) {
                const extra = Math.floor(datos.monto * bono);
                if (extra > 0) {
                    montoRecibeFinal += extra;
                    notas.push(esEs ? `${extra} CUP extra por tu tasa VIP` : `${extra} CUP extra pela sua taxa VIP`);
                }
            }

            if (notas.length) {
                const estrellas = "⭐".repeat(nivel);
                notaVip = esEs
                    ? `\n\n${estrellas} Beneficio VIP aplicado: ${notas.join(" + ")}.`
                    : `\n\n${estrellas} Benefício VIP aplicado: ${notas.join(" + ")}.`;
            }
            const oferta = await obtenerOfertaVip();
            if (oferta) notaVip += `\n\n🔥 ${oferta}`;
        } catch (e) {
            console.error("❌ Error aplicando beneficios VIP (transferencia):", e.message);
        }
    }

    const operacion = await agregarOperacion({
        phone,
        nombre:  pushName || datos.nombreBenef || "Cliente",
        monto:   datos.monto,
        cup:     datos.moneda === "CUP" ? montoRecibeFinal : 0,
        tarjeta: datos.tarjeta,
        titular: datos.nombreBenef,
        banco:   datos.banco,
        tipo,
        refWeb:  datos.ref
    });

    if (!operacion) return false;

    // Marca al cliente para que el bot conversacional se quede en silencio si
    // manda algo más (ver el guard en openai.js) — este pedido ya se maneja
    // 100% desde el dashboard, no necesita que el bot intervenga.
    await guardarCliente({ phone, estado: "pedido_web_pendiente" });

    await enviarSeguro(phone, esEs
        ? `📩 Recibimos tu pedido #${operacion.id}. Lo estamos verificando, te avisamos en cuanto esté confirmado. 🇨🇺${notaVip}`
        : `📩 Recebemos seu pedido #${operacion.id}. Estamos verificando, avisamos assim que for confirmado. 🇨🇺${notaVip}`
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

module.exports = {
    esPedidoWeb, procesarPedidoWeb,
    // exportados también para pruebas automáticas (test/pedido-web-flow.test.js) —
    // son funciones puras, no tocan WhatsApp ni la base de datos
    esEntrega, parsearPedidoEntrega, parsearPedidoTransferencia, limpiarNumero
};
