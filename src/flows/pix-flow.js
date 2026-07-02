"use strict";

const pool        = require("../../db");
const memoryMotor = require("../services/memory-motor");
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

    // SEGURIDAD: si el cliente no envió tarjeta en esta sesión (cliente.tarjeta = null)
    // pero tiene tarjeta_frecuente histórica → mostrarla y pedir confirmación
    // Nunca asumir silenciosamente que es la correcta
    if (!esRecarga && !cliente?.tarjeta && cliente?.tarjeta_frecuente) {
        const ultimos = String(cliente.tarjeta_frecuente).slice(-4);
        const lang    = cliente?.idioma === "pt" ? "pt" : "es";
        const msg     = lang === "pt"
            ? `Tenho um cartão guardado *••••${ultimos}*. Vamos usar esse ou você quer enviar outro? 💳`
            : `Tengo una tarjeta guardada *••••${ultimos}*. ¿Usamos esa o quieres enviar otra? 💳`;
        await guardarCliente({ phone, estado: "seleccionando_tarjeta", fechaEstado: new Date().toISOString() });
        await enviarSeguro(phone, msg);
        return msg;
    }

    if (!esRecarga && !cliente?.tarjeta && !cliente?.tarjeta_frecuente) {
        const msg = esEs
            ? "Solo me falta la tarjeta de destino 💳\n\nEnvíame una foto o los 16 dígitos."
            : "Só falta o cartão de destino 💳\n\nEnvie uma foto ou os 16 dígitos.";
        await enviarSeguro(phone, msg);
        return msg;
    }

    // Múltiples tarjetas → mostrar de forma natural con nombre
    const tarjetas = Array.isArray(cliente?.tarjetas) ? cliente.tarjetas.filter(t => /^\d{15,16}$/.test(t)) : [];
    if (!esRecarga && tarjetas.length > 1) {
        // MEJORA 5: lenguaje natural — "encontré estas tarjetas registradas"
        const primerNombre = cliente?.nombre ? cliente.nombre.split(" ")[0] : null;
        const titular      = cliente?.titular_frecuente ? cliente.titular_frecuente.split(" ")[0] : null;
        const opciones = tarjetas.map((t, i) => {
            const ultimos = t.slice(-4);
            return `${i + 1}️⃣ •••• ${ultimos}${titular ? " — " + titular : ""}`;
        }).join("\n");
        const intro = esEs
            ? `Encontré estas tarjetas guardadas${primerNombre ? ` a tu nombre, ${primerNombre}` : ""} 💳\n\n${opciones}\n\n¿Cuál usamos hoy?`
            : `Encontrei estes cartões salvos${primerNombre ? ` no seu nome, ${primerNombre}` : ""} 💳\n\n${opciones}\n\n¿Qual usamos hoje?`;
        await guardarCliente({ phone, estado: "seleccionando_tarjeta", fechaEstado: new Date().toISOString() });
        await enviarSeguro(phone, intro);
        return intro;
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
    const lang             = cliente.idioma === "pt" ? "pt" : "es";

    // ── Resolver monto ──────────────────────────────────────────
    // Prioridad: ultimo_monto → valor_comprobante → null
    let monto = Number(cliente.ultimo_monto) > 0 ? Number(cliente.ultimo_monto) : null;
    if (!monto && Number(cliente.valor_comprobante) > 0) {
        monto = Number(cliente.valor_comprobante);
        await guardarCliente({ phone, monto });
        cliente = await obtenerCliente(phone);
    }

    // ── Resolver tarjeta ────────────────────────────────────────
    // SEGURIDAD: solo usar tarjeta si el cliente la envió en esta sesión
    // (cliente.tarjeta = enviada ahora, tarjeta_frecuente = histórica)
    // NUNCA completar operación con tarjeta_frecuente sin confirmación explícita
    const tarjeta = cliente.tarjeta || null;

    // ── Resolver tipo ────────────────────────────────────────────
    if (!cliente.tipo_favorito && tarjeta) {
        await guardarCliente({ phone, tipo: "brl_cup" });
        cliente = await obtenerCliente(phone);
    }

    const tieneMonto       = !!monto;
    const tieneTarjeta     = !!tarjeta || esRecarga;
    const tieneComprobante = !!cliente.comprobante_pendiente;

    // ── Faltan datos — pedir solo lo que falta ──────────────────
    if (!tieneMonto && !tieneComprobante) {
        // No tiene nada — pedir monto
        const msg = lang === "pt" ? "Quanto vai enviar? 😊" : "¿Cuánto vas a enviar? 😊";
        await enviarSeguro(phone, msg);
        return false;
    }

    if (!tieneMonto && tieneComprobante) {
        // Tiene comprobante pero no monto — el OCR no detectó el valor
        const msg = lang === "pt"
            ? "Recebi o comprovante 📎 Mas não consegui ler o valor. ¿Qual o valor que você pagou?"
            : "Recibí el comprobante 📎 Pero no pude leer el valor. ¿Cuánto pagaste?";
        await enviarSeguro(phone, msg);
        return false;
    }

    if (tieneMonto && !tieneComprobante && !tieneTarjeta) {
        // Tiene monto pero no tarjeta ni comprobante — pedir tarjeta
        const msg = lang === "pt"
            ? "Solo me falta o cartão de destino 💳\n\nManda uma foto ou os 16 dígitos."
            : "Solo me falta la tarjeta de destino 💳\n\nEnvíame foto o los 16 dígitos.";
        await enviarSeguro(phone, msg);
        return false;
    }

    if (tieneMonto && tieneTarjeta && !tieneComprobante) {
        // Tiene monto y tarjeta — solo falta comprobante (ya debería tener PIX)
        return false;
    }

    if (!tieneTarjeta && tieneComprobante && tieneMonto) {
        // Tiene comprobante y monto pero no tarjeta
        const msg = lang === "pt"
            ? "Comprovante recebido ✅\n\nSó falta o cartão de destino 💳\n\nManda uma foto ou os 16 dígitos."
            : "Comprobante recibido ✅\n\nSolo falta la tarjeta de destino 💳\n\nEnvíame foto o los 16 dígitos.";
        await enviarSeguro(phone, msg);
        return false;
    }

    // ── Tenemos todo — completar operación ──────────────────────
    const yaExiste = await existeOperacionPendiente(phone, monto);
    if (yaExiste) return true;

    const resultado = await calcularOperacion({ tipo: cliente.tipo_favorito || "brl_cup", valor: monto });

    await guardarCliente({ phone, comprobantePendiente: false });
    const operacion = await agregarOperacion({
        phone,
        nombre:  pushName || cliente.nombre || "Cliente",
        monto,
        cup:     resultado?.cup || 0,
        tarjeta: tarjeta || "",
        titular: cliente.titular || cliente.titular_frecuente || "",
        banco:   cliente.banco_detectado || "",
        tipo:    cliente.tipo_favorito || "brl_cup"
    });

    const opId      = operacion?.id ? `#${operacion.id} ` : "";
    const tarjetaFmt = tarjeta && tarjeta !== "-"
        ? tarjeta.replace(/(.{4})/g, "$1 ").trim()
        : "-";

    const msgOperacion = `📥 *OPERACIÓN ${opId}PENDIENTE*\n\n👤 Cliente: ${pushName || cliente.nombre}\n\n📱 Teléfono: ${phone}\n\n💵 Enviado: R$${monto}\n\n🇨🇺 Recibe: ${fmt(resultado?.cup || 0)} CUP\n\n🏦 Banco: ${cliente.banco_detectado || "-"}\n\n💳 Tarjeta:\n${tarjetaFmt}\n\n👤 Titular:\n${cliente.titular || cliente.titular_frecuente || "-"}\n\n⏳ Estado:\nPendiente de validación`;

    await enviarSeguro(phone, msgOperacion);

    const adminPhone = getAdminPhone();
    if (adminPhone) await enviarSeguro(adminPhone, msgOperacion);
    else console.warn("⚠️ ADMIN_PHONE no configurado");

    await etiquetarNuevoPedido(phone);

    // GRUPO B — Actualizar score de confianza al completar operación
    try {
        await pool.query(`
            UPDATE customers SET
                score_confianza = LEAST(100, COALESCE(score_confianza, 0) + 10),
                ops_completadas = COALESCE(ops_completadas, 0) + 1,
                updated_at = NOW()
            WHERE phone = $1
        `, [phone]);
    } catch (_) {}

    // GRUPO C — Actualizar motor de memoria comercial (background)
    const fechaCotPrevia = cliente?.fecha_cotizacion;
    memoryMotor.actualizarPatrones(phone).catch(() => {});
    memoryMotor.actualizarVelocidadDecision(phone, fechaCotPrevia).catch(() => {});

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
    // MEJORA 3: Progreso paso a paso — reduce ansiedad del cliente
    const msgPaso1 = esEs
        ? "📄 *Paso 1/3* — Comprobante recibido ✅\n\nVerificando el pago..."
        : "📄 *Passo 1/3* — Comprovante recebido ✅\n\nVerificando o pagamento...";
    await enviarSeguro(phone, msgPaso1);

    const completado = await intentarCompletarOperacion(phone, pushName, clienteActualizado, esEs);

    if (!completado) {
        const msgPaso2 = esEs
            ? "📋 *Paso 2/3* — Pago localizado ✅\n\nEsperando confirmación del operador. Te avisamos enseguida 😊"
            : "📋 *Passo 2/3* — Pagamento localizado ✅\n\nAguardando confirmação do operador. Avisamos em breve 😊";
        await enviarSeguro(phone, msgPaso2);
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
