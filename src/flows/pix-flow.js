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

    // QR image
    if (img) await enviarImagen(phone, img, "📲 Escanea el QR para pagar.");
    // Clave PIX sola — para copiar fácilmente
    if (key) await enviarSeguro(phone, key);
    // Titular + instrucción en un mensaje
    const msgPIX = [
        holder ? `👤 ${holder}${bank ? ` · ${bank}` : ""}` : null,
        esEs ? "Cuando pagues mándame el comprobante 📎" : "Quando pagar me manda o comprovante 📎"
    ].filter(Boolean).join("\n");
    await enviarSeguro(phone, msgPIX);
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

    // Mensaje corto al cliente
    const msgCliente = esEs
        ? `✅ ¡Listo! Tu operación está en proceso.\n\nR$${monto} → ${fmt(resultado?.cup || 0)} CUP 🇨🇺\n\nTe avisamos cuando se complete 😊`
        : `✅ Pronto! Sua operação está em processamento.\n\nR$${monto} → ${fmt(resultado?.cup || 0)} CUP 🇨🇺\n\nAvisamos quando concluir 😊`;
    await enviarSeguro(phone, msgCliente);

    // Mensaje detallado al admin
    const msgAdmin = `📥 *OP ${opId}PENDIENTE*\n👤 ${pushName || cliente.nombre} · ${phone.replace("@s.whatsapp.net","").replace("@c.us","")}\n💵 R$${monto} → ${fmt(resultado?.cup || 0)} CUP\n🏦 ${cliente.banco_detectado || "-"}\n💳 ${tarjetaFmt}\n👤 ${cliente.titular || cliente.titular_frecuente || "-"}`;
    const adminPhone = getAdminPhone();
    if (adminPhone) await enviarSeguro(adminPhone, msgAdmin);
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

    // Validar duplicado — buscar en comprobantes ya procesados
    if (datos.valor && datos.fecha) {
        try {
            // Buscar en tabla comprobantes (historial completo)
            const dupComp = await pool.query(`
                SELECT id FROM comprobantes
                WHERE phone = $1
                AND valor = $2
                AND fecha_pix = $3
                LIMIT 1
            `, [phone, Number(datos.valor), datos.fecha]);

            if (dupComp.rows.length > 0) {
                await enviarSeguro(phone, "⚠️ Este comprobante ya fue procesado anteriormente.\n\nSi tienes alguna duda escríbeme a Yordanys. 😊");
                return "";
            }

            // También buscar en operaciones recientes (últimas 72h)
            const dupOp = await pool.query(`
                SELECT id FROM operations
                WHERE phone = $1
                AND monto = $2
                AND created_at > NOW() - INTERVAL '72 hours'
                AND status != 'rechazada'
                LIMIT 1
            `, [phone, Number(datos.valor)]);

            if (dupOp.rows.length > 0) {
                await enviarSeguro(phone, "⚠️ Ya tenemos una operación registrada con ese monto.\n\nSi tienes alguna duda contacta a Yordanys. 😊");
                return "";
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

    // #8 Guardar en historial de comprobantes
    try {
        await pool.query(`
            INSERT INTO comprobantes
                (phone, nombre, valor, fecha_pix, hora_pix, banco_origen, destinatario, destino_correcto, valido)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT DO NOTHING
        `, [
            phone, pushName || null,
            datos.valor || null, datos.fecha || null, datos.hora || null,
            datos.banco || null, datos.destinatario || null,
            datos.destino_correcto ?? null, datos.valido ?? null
        ]);
    } catch (_) {}

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
        const msgRecibido = esEs
            ? "✅ Comprobante recibido. Te avisamos cuando confirmemos 😊"
            : "✅ Comprovante recebido. Avisamos quando confirmarmos 😊";
        await enviarSeguro(phone, msgRecibido);
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
