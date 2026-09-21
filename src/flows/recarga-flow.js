"use strict";

const pool               = require("../../db");
const { guardarCliente, obtenerCliente } = require("../services/customer-memory");
const { enviarSeguro }   = require("./shared");
const { enviarPIX }      = require("./pix-flow");
const { interpretarSeleccionRecarga, nombraModalidadRecarga, normalizarNumeroCubano } = require("../services/reglas-bot");

// ─────────────────────────────────────────
// LEER RECARGAS DISPONIBLES
// ─────────────────────────────────────────

// La disponibilidad se calcula EN LA CONSULTA (sin cron/job que la apague
// físicamente): activa=true Y (sin fecha límite O todavía no vencida).
// disponible_hasta es TIMESTAMPTZ -- comparar contra NOW() en Postgres es
// siempre correcto sin importar la zona horaria del proceso (ver
// migrations/0013_recarga_fecha_limite.sql y src/utils/timezone.js).
async function leerRecargas() {
    try {
        const r = await pool.query(`
            SELECT * FROM recargas
            WHERE activa = true
              AND (disponible_hasta IS NULL OR disponible_hasta >= NOW())
            ORDER BY tipo
        `);
        return r.rows;
    } catch { return []; }
}

// ─────────────────────────────────────────
// MOSTRAR MENÚ DE RECARGAS
// ─────────────────────────────────────────

// El dashboard (Configuración de Recargas) es la fuente de verdad: leerRecargas()
// ya filtra "activa = true" -- este mensaje solo tiene que redactarse según
// CUÁNTAS modalidades resultaron activas ahora mismo (nunca hardcodear "dos
// tipos" si el admin desactivó una, ni si Internacional venció).
async function mostrarMenuRecargas(phone) {
    const recargas = await leerRecargas();
    if (recargas.length === 0) {
        await enviarSeguro(phone, "Por el momento no tenemos recargas disponibles. Pregunta a Yordanys 😊");
        return "";
    }

    let msg;
    if (recargas.length === 1) {
        const r = recargas[0];
        const emoji = r.tipo === "nacional" ? "🇨🇺" : "🌍";
        msg = `📱 *Recarga ${r.tipo.charAt(0).toUpperCase() + r.tipo.slice(1)}*\n\n${emoji} R$${r.precio}\n${r.descripcion}\n\n¿La confirmamos? Responde *1* o "sí" 😊`;
    } else {
        msg = "📱 *Tenemos estos tipos de recarga:*\n\n";
        recargas.forEach((r, i) => {
            const emoji = r.tipo === "nacional" ? "🇨🇺" : "🌍";
            msg += `${i + 1}️⃣ *Recarga ${r.tipo.charAt(0).toUpperCase() + r.tipo.slice(1)}*\n`;
            msg += `${emoji} R$${r.precio}\n`;
            msg += `${r.descripcion}\n\n`;
        });
        msg += `¿Cuál prefieres? Responde ${recargas.map((_, i) => `*${i + 1}*`).join(" o ")}, o dime el nombre 😊`;
    }

    await guardarCliente({ phone, estado: "seleccionando_recarga", fechaEstado: new Date().toISOString() });
    await enviarSeguro(phone, msg);
    return msg;
}

// Si el mensaje del cliente YA nombra una modalidad puntual ("quiero una
// recarga internacional"), permite ir directo a esa opción sin mostrar el
// menú -- solo si esa modalidad concreta está disponible ahora mismo.
// Devuelve "" (ya respondió) o null si no hubo coincidencia directa (el
// caller debe mostrar el menú normal).
async function intentarSeleccionDirecta(phone, txt) {
    const recargas = await leerRecargas();
    if (recargas.length <= 1) return null; // con 0 o 1 opción, el menú ya es lo más directo posible
    const tipo = nombraModalidadRecarga(txt, recargas);
    if (!tipo) return null;
    return await iniciarSeleccionRecarga(phone, tipo, recargas);
}

// ─────────────────────────────────────────
// SELECCIÓN DE TIPO DE RECARGA
// ─────────────────────────────────────────

// Acepta dígito (1/2), nombre ("nacional"/"internacional"), ordinal ("la
// primera"/"la segunda"), o una confirmación suelta ("esa"/"sí") cuando
// hay una única opción -- ver interpretarSeleccionRecarga en reglas-bot.js.
async function seleccionarRecarga(phone, texto, esEs = true) {
    const recargas = await leerRecargas(); // REVALIDA al seleccionar
    const tipoElegido = interpretarSeleccionRecarga(texto, recargas);

    if (tipoElegido === "AMBIGUO") {
        const opcionesTxt = recargas.map((r, i) => `*${i + 1}* (${r.tipo})`).join(" o ");
        await enviarSeguro(phone, esEs
            ? `No me quedó claro cuál -- ¿me dices ${opcionesTxt}? 😊`
            : `Não ficou claro -- pode me dizer ${opcionesTxt}? 😊`);
        return "";
    }
    if (!tipoElegido) {
        const opcionesTxt = recargas.map((_, i) => `*${i + 1}*`).join(" o ") || "una opción válida";
        await enviarSeguro(phone, `Responde ${opcionesTxt} 😊`);
        return "";
    }
    return await iniciarSeleccionRecarga(phone, tipoElegido, recargas, esEs);
}

async function iniciarSeleccionRecarga(phone, tipo, recargasConocidas, esEs = true) {
    const recargas = recargasConocidas || await leerRecargas();
    const recargaElegida = recargas.find(r => r.tipo === tipo);
    if (!recargaElegida) {
        // Revalidación: dejó de estar disponible entre que se mostró y se eligió.
        await enviarSeguro(phone, esEs
            ? "Esa modalidad ya no está disponible en este momento 😕"
            : "Essa modalidade não está mais disponível 😕");
        return await mostrarMenuRecargas(phone);
    }
    await guardarCliente({
        phone,
        monto: recargaElegida.precio,
        tipo: `recarga_${recargaElegida.tipo}`,
        estado: "aguardando_numero_recarga",
        fechaEstado: new Date().toISOString()
    });
    await enviarSeguro(phone, esEs
        ? "Perfecto 😊\n\n¿Cuál es el número cubano a recargar?\n\nEjemplo: 51234567 (con o sin +53)"
        : "Perfeito 😊\n\nQual o número cubano para recarregar?\n\nExemplo: 51234567 (com ou sem +53)");
    return "";
}

// ─────────────────────────────────────────
// NÚMERO CUBANO PARA RECARGA
// ─────────────────────────────────────────

// Acepta 51234567 / +5351234567 / 53 51234567 / +53 51234567 (ver
// normalizarNumeroCubano en reglas-bot.js). Si el formato no es válido,
// NUNCA silencio -- se explica brevemente con un ejemplo.
//
// IMPORTANTE: si el cliente empezó esta recarga y el administrador
// desactivó/venció esa modalidad en el medio (dashboard), no se avanza
// basándose en el contexto viejo -- se revalida contra la configuración
// ACTUAL antes de mostrar el resumen.
async function procesarNumeroRecarga(phone, textoOriginal, esEs) {
    const numero = normalizarNumeroCubano(textoOriginal);
    if (!numero) {
        await enviarSeguro(phone, esEs
            ? "Necesito un número cubano válido 😊\n\nEjemplo: 51234567 (con o sin +53)"
            : "Preciso de um número cubano válido 😊\n\nExemplo: 51234567 (com ou sem +53)");
        return "";
    }

    const clienteActual = await obtenerCliente(phone);
    const tipoElegido = String(clienteActual?.tipo_favorito || "").replace("recarga_", "");
    const recargasActivas = await leerRecargas();
    const recargaVigente = recargasActivas.find(r => r.tipo === tipoElegido);

    if (!recargaVigente) {
        const msg = esEs
            ? "Esa modalidad de recarga ya no está disponible en este momento 😊"
            : "Essa modalidade de recarga não está mais disponível 😊";
        await enviarSeguro(phone, msg);
        return await mostrarMenuRecargas(phone);
    }

    await guardarCliente({
        phone,
        tarjeta: numero,
        estado: "confirmando_recarga",
        fechaEstado: new Date().toISOString()
    });
    await enviarSeguro(phone, construirResumenRecarga(recargaVigente, numero, esEs));
    return "";
}

function construirResumenRecarga(recarga, numero, esEs = true) {
    const label = recarga.tipo.charAt(0).toUpperCase() + recarga.tipo.slice(1);
    return esEs
        ? `📋 *Resumen de tu recarga*\n\n📱 Recarga: ${label}\n📞 Número: ${numero}\n💵 Precio: R$${recarga.precio}\n📶 ${recarga.descripcion}\n\n¿Confirmamos? 😊`
        : `📋 *Resumo da sua recarga*\n\n📱 Recarga: ${label}\n📞 Número: ${numero}\n💵 Preço: R$${recarga.precio}\n📶 ${recarga.descripcion}\n\nConfirmamos? 😊`;
}

// ─────────────────────────────────────────
// CONFIRMACIÓN DEL RESUMEN → PIX
// ─────────────────────────────────────────

// Solo después de confirmar el resumen se muestran los datos PIX.
// Revalida DE NUEVO la disponibilidad justo antes (además de al mostrar
// opciones y al seleccionar) -- cubre el caso de que la modalidad venza/se
// desactive mientras el cliente estaba mirando el resumen.
async function confirmarResumenRecarga(phone, esEs) {
    const cliente = await obtenerCliente(phone);
    const tipoElegido = String(cliente?.tipo_favorito || "").replace("recarga_", "");
    const recargasActivas = await leerRecargas();
    const recargaVigente = recargasActivas.find(r => r.tipo === tipoElegido);

    if (!recargaVigente) {
        const msg = esEs
            ? "Esa modalidad de recarga ya no está disponible en este momento 😕"
            : "Essa modalidade de recarga não está mais disponível 😕";
        await enviarSeguro(phone, msg);
        return await mostrarMenuRecargas(phone);
    }

    // Precio siempre desde la configuración vigente en este instante --
    // nunca el que se guardó al momento de elegir, por si cambió en el medio.
    await guardarCliente({
        phone,
        monto: recargaVigente.precio,
        estado: "aguardando_comprovante",
        fechaEstado: new Date().toISOString(),
        fechaPix: new Date().toISOString()
    });
    const cli = await obtenerCliente(phone);
    return await enviarPIX(phone, cli, esEs);
}

// ─────────────────────────────────────────
// CAMBIOS DENTRO DE UNA RECARGA ACTIVA (antes del comprobante)
// ─────────────────────────────────────────

// "mejor la nacional"/"mejor la internacional" -- cambia de modalidad
// conservando el flujo (vuelve a pedir el número, porque el precio y la
// descripción son distintos). Revalida disponibilidad de la nueva modalidad.
async function cambiarModalidadRecarga(phone, tipoNuevo, esEs) {
    const recargas = await leerRecargas();
    return await iniciarSeleccionRecarga(phone, tipoNuevo, recargas, esEs);
}

// "cambia el número"/"me equivoqué de número"/"no, para otro número" --
// vuelve a pedir el número SIN perder la modalidad ya elegida.
async function cambiarNumeroRecarga(phone, esEs) {
    await guardarCliente({ phone, estado: "aguardando_numero_recarga", fechaEstado: new Date().toISOString() });
    await enviarSeguro(phone, esEs
        ? "Sin problema 😊 ¿Cuál es el número correcto?"
        : "Sem problema 😊 Qual é o número correto?");
    return "";
}

module.exports = {
    leerRecargas,
    mostrarMenuRecargas,
    intentarSeleccionDirecta,
    seleccionarRecarga,
    procesarNumeroRecarga,
    confirmarResumenRecarga,
    cambiarModalidadRecarga,
    cambiarNumeroRecarga
};
