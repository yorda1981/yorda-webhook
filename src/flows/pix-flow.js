"use strict";

const pool = require("../../db");
const { guardarCliente, obtenerCliente }                                          = require("../services/customer-memory");
const { agregarOperacion, existeOperacionPendiente, obtenerPendienteCliente }     = require("../services/operations");
const { calcularOperacion }                                                        = require("../services/calculator");
const { enviarMensaje, enviarImagen }                                              = require("../services/zapi");
const crm                                                                          = require("../services/crm");
const {
    enviarSeguro, limpiarSesion, fmt, pick, pickL,
    getPIXKey, getPIXHolder, getPIXBank, getPIXImage, getAdminPhone,
    ESPERA_COMPROBANTE_ES, ESPERA_COMPROBANTE_PT
} = require("./shared");

// ─────────────────────────────────────────
// NOTIFICAR ADMIN
// ─────────────────────────────────────────

async function notificarAdmin(pushName, phone, monto, cup, banco, tarjeta, titular) {
    const adminPhone = getAdminPhone();
    if (!adminPhone) { console.warn("⚠️ ADMIN_PHONE no configurado"); return; }
    await enviarSeguro(adminPhone,
        `📥 *NUEVA OPERACIÓN*\n👤 ${pushName}\n📱 ${phone}\n💵 R$${monto} → ${fmt(cup)} CUP\n🏦 ${banco || "-"}\n💳 ${tarjeta || "-"}\n👤 ${titular || "-"}\n⏳ Pendiente`
    );
}

// ─────────────────────────────────────────
// ETIQUETAR EN WASCRIPT CRM
// ─────────────────────────────────────────

async function etiquetarNuevoPedido(phone) {
    const token = process.env.WASCRIPT_TOKEN;
    if (!token) return;
    try {
        await fetch(`https://api-whatsapp.wascript.com.br/api/modificar-etiquetas/${token}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone: [phone], actions: [{ labelId: "2", type: "add" }] })
        });
        console.log(`🏷️ Etiqueta agregada: ${phone}`);
    } catch (e) {
        console.error("❌ Wascript:", e.message);
    }
}

// ─────────────────────────────────────────
// ENVIAR PIX
// ─────────────────────────────────────────

async function enviarPIX(phone, cliente, esEs) {
    if (!cliente?.ultimo_monto || Number(cliente.ultimo_monto) <= 0) {
        const msg = esEs ? "Primero dime cuánto vas a enviar 😊" : "Primeiro me diz quanto vai enviar 😊";
        await enviarSeguro(phone, msg);
        return msg;
    }
    const esRecarga = cliente?.tipo_favorito === "recarga_etecsa";
    if (!esRecarga && !cliente?.tarjeta && !cliente?.tarjeta_frecuente) {
        const msg = esEs
            ? "Solo me falta la tarjeta de destino 💳\n\nEnvíame una foto o los 16 dígitos."
            : "Só falta o cartão de destino 💳\n\nEnvie uma foto ou os 16 dígitos.";
        await enviarSeguro(phone, msg);
        return msg;
    }

    // Múltiples tarjetas → elegir cuál
    const tarjetas = Array.isArray(cliente?.tarjetas) ? cliente.tarjetas.filter(t => /^\d{15,16}$/.test(t)) : [];
    if (!esRecarga && tarjetas.length > 1) {
        const opciones = tarjetas.map((t, i) => {
            const ultimos = t.slice(-4);
            const titular = cliente.titular_frecuente || "";
            return `${i + 1}️⃣ •••• ${ultimos}${titular ? " — " + titular.split(" ")[0] : ""}`;
        }).join("\n");
        const msg = `¿A cuál tarjeta envío hoy? 💳\n\n${opciones}`;
        await guardarCliente({ phone, estado: "seleccionando_tarjeta", fechaEstado: new Date().toISOString() });
        await enviarSeguro(phone, msg);
        return msg;
    }

    return await _enviarPIXFinal(phone, cliente, esEs);
}

async function _enviarPIXFinal(phone, cliente, esEs) {
    const key = getPIXKey(); const holder = getPIXHolder();
    const bank = getPIXBank(); const img = getPIXImage();

    if (img)    await enviarImagen(phone, img, "📲 Escanea el QR para pagar.");
    if (key)    await enviarSeguro(phone, key);
    if (holder) await enviarSeguro(phone, `Titular: ${holder}${bank ? `\n🏦 ${bank}` : ""}`);
    await enviarSeguro(phone, esEs
        ? "Después del pago envíame el comprobante 📎 y proceso tu envío enseguida 🚀"
        : "Após o pagamento envie o comprovante 📎 e processo imediatamente 🚀"
    );
    await crm.onPIXEnviado(phone, esEs ? "es" : "pt");
    return key;
}

// ─────────────────────────────────────────
// INTENTAR COMPLETAR OPERACIÓN
// ─────────────────────────────────────────

async function intentarCompletarOperacion(phone, pushName, cliente, esEs) {
    if (!cliente) return false;
    const esRecarga        = cliente.tipo_favorito === "recarga_etecsa";
    const tieneTarjeta     = !!(cliente.tarjeta || cliente.tarjeta_frecuente);
    const tieneComprobante = !!cliente.comprobante_pendiente;

    if (tieneTarjeta && tieneComprobante && !cliente.ultimo_monto) {
        const montoComp = Number(cliente.valor_comprobante);
        if (montoComp > 0) {
            await guardarCliente({ phone, monto: montoComp, tipo: cliente.tipo_favorito || "brl_cup" });
            const cli2 = await obtenerCliente(phone);
            return await intentarCompletarOperacion(phone, pushName, cli2, esEs);
        }
    }

    const tieneMonto = Number(cliente.ultimo_monto) > 0;

    if (tieneTarjeta && tieneComprobante && !cliente.tipo_favorito) {
        await guardarCliente({ phone, tipo: "brl_cup" });
        const cli2 = await obtenerCliente(phone);
        return await intentarCompletarOperacion(phone, pushName, cli2, esEs);
    }

    if (!tieneMonto || !tieneComprobante || (!tieneTarjeta && !esRecarga)) {
        if (!tieneMonto) {
            await enviarSeguro(phone, esEs ? "¿Cuánto vas a enviar? 😊" : "Quanto vai enviar? 😊");
            return false;
        }
        if (!tieneTarjeta && !esRecarga) {
            await enviarSeguro(phone, esEs
                ? "Solo me falta la tarjeta de destino 💳\n\nEnvíame foto o los 16 dígitos."
                : "Só falta o cartão 💳\n\nFoto ou 16 dígitos."
            );
            return false;
        }
        return false;
    }

    const yaExiste = await existeOperacionPendiente(phone, cliente.ultimo_monto);
    if (yaExiste) return true;

    const resultado = await calcularOperacion({ tipo: cliente.tipo_favorito, valor: cliente.ultimo_monto });

    await guardarCliente({ phone, comprobantePendiente: false });
    const operacion = await agregarOperacion({
        phone,
        nombre:  pushName || cliente.nombre || "Cliente",
        monto:   cliente.ultimo_monto,
        cup:     resultado?.cup || 0,
        tarjeta: cliente.tarjeta || cliente.tarjeta_frecuente || "",
        titular: cliente.titular || cliente.titular_frecuente || "",
        banco:   cliente.banco_detectado || "",
        tipo:    cliente.tipo_favorito
    });

    const opId      = operacion?.id ? `#${operacion.id} ` : "";
    const tarjetaRaw = cliente.tarjeta || cliente.tarjeta_frecuente || "-";
    const tarjetaFmt = tarjetaRaw !== "-" ? tarjetaRaw.replace(/(.{4})/g, "$1 ").trim() : "-";

    const tipoOp   = cliente.tipo_favorito || "brl_cup";
    const totalBrl = resultado?.cup ?? resultado?.brl ?? 0;
    let lineasMonto;
    if (tipoOp.startsWith("usd")) {
        lineasMonto = `🇨🇺 Recibe: ${cliente.ultimo_monto} USD\n\n💵 Paga: R$${fmt(totalBrl)}`;
    } else if (tipoOp === "mlc") {
        lineasMonto = `🇨🇺 Recibe: ${cliente.ultimo_monto} MLC\n\n💵 Paga: R$${fmt(totalBrl)}`;
    } else {
        lineasMonto = `💵 Enviado: R$${cliente.ultimo_monto}\n\n🇨🇺 Recibe: ${fmt(resultado?.cup || 0)} CUP`;
    }

    const msgOperacion = `📥 *OPERACIÓN ${opId}PENDIENTE*

👤 Cliente: ${pushName || cliente.nombre}

📱 Teléfono: ${phone}

${lineasMonto}

🏦 Banco: ${cliente.banco_detectado || "-"}

💳 Tarjeta:
${tarjetaFmt}

👤 Titular:
${cliente.titular || cliente.titular_frecuente || "-"}

⏳ Estado:
Pendiente de validación`;

    await enviarSeguro(phone, msgOperacion);

    const adminPhone = getAdminPhone();
    if (adminPhone) await enviarSeguro(adminPhone, msgOperacion);
    else console.warn("⚠️ ADMIN_PHONE no configurado");

    await etiquetarNuevoPedido(phone);
    await limpiarSesion(phone);
    return true;
}

// ─────────────────────────────────────────
// PROCESAR COMPROBANTE
// ─────────────────────────────────────────

async function procesarComprobante(phone, pushName, cliente, datos, esEs) {
    if (datos.destino_correcto === false) {
        await enviarSeguro(phone, "⚠️ El comprobante no es para nuestra cuenta.\n\nVerifica el destinatario y reenvíalo.");
        return "";
    }

    // Validar duplicado
    if (datos.valor && datos.fecha && datos.hora) {
        try {
            const dupCheck = await pool.query(`
                SELECT id FROM operations
                WHERE monto = $1
                AND created_at > NOW() - INTERVAL '24 hours'
                AND status != 'rechazada'
                LIMIT 1
            `, [Number(datos.valor)]);

            if (dupCheck.rows.length > 0) {
                const dupCliente = await pool.query(`
                    SELECT id FROM operations
                    WHERE phone = $1 AND monto = $2
                    AND created_at > NOW() - INTERVAL '2 hours'
                    LIMIT 1
                `, [phone, Number(datos.valor)]);

                if (dupCliente.rows.length > 0) {
                    await enviarSeguro(phone, "⚠️ Este comprobante ya fue procesado anteriormente.\n\nSi tienes alguna duda contacta a Yordanys. 😊");
                    return "";
                }
            }
        } catch (e) {
            console.error("❌ Error validando duplicado:", e.message);
        }
    }

    await guardarCliente({
        phone,
        comprobantePendiente: true,
        valorComprobante: datos.valor ?? null,
        ...(datos.valor && !cliente.ultimo_monto && { monto: datos.valor })
    });

    const opPend = await obtenerPendienteCliente(phone);
    if (opPend && datos.valor &&
        Math.round(Number(datos.valor)) !== Math.round(Number(opPend.monto))
    ) {
        await enviarSeguro(phone,
            `⚠️ El comprobante es R$${datos.valor} pero la operación es R$${opPend.monto}.\n\nVerifica y reenvíalo.`
        );
        return "";
    }

    const clienteActualizado = await obtenerCliente(phone);
    const completado = await intentarCompletarOperacion(phone, pushName, clienteActualizado, esEs);

    if (!completado) {
        await enviarSeguro(phone, esEs ? "¡Comprobante recibido! ✅" : "Comprovante recebido! ✅");
    }

    return "";
}

// ─────────────────────────────────────────
// GUARDAR TARJETA
// ─────────────────────────────────────────

async function guardarTarjeta(phone, num, titular, banco, cliente) {
    const arr = Array.isArray(cliente?.tarjetas) ? [...cliente.tarjetas] : [];
    if (!arr.includes(num)) arr.push(num);
    await guardarCliente({
        phone, tarjeta: num, titular: titular || "",
        bancoDetectado: banco || "", tarjeta_frecuente: num,
        titular_frecuente: titular || "", banco_detectado: banco || "",
        tarjetas: arr
    });
}

module.exports = {
    enviarPIX,
    _enviarPIXFinal,
    intentarCompletarOperacion,
    procesarComprobante,
    guardarTarjeta,
    notificarAdmin
};
