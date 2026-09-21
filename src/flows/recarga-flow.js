"use strict";

const pool               = require("../../db");
const { guardarCliente, obtenerCliente } = require("../services/customer-memory");
const { enviarSeguro }   = require("./shared");
const { enviarPIX }      = require("./pix-flow");

// ─────────────────────────────────────────
// LEER RECARGAS DISPONIBLES
// ─────────────────────────────────────────

async function leerRecargas() {
    try {
        const r = await pool.query("SELECT * FROM recargas WHERE activa = true ORDER BY tipo");
        return r.rows;
    } catch { return []; }
}

// ─────────────────────────────────────────
// MOSTRAR MENÚ DE RECARGAS
// ─────────────────────────────────────────

// El dashboard (Configuración de Recargas) es la fuente de verdad: leerRecargas()
// ya filtra "activa = true" -- este mensaje solo tiene que redactarse según
// CUÁNTAS modalidades resultaron activas ahora mismo (nunca hardcodear "dos
// tipos" si el admin desactivó una).
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
        msg = `📱 *Recarga ${r.tipo.charAt(0).toUpperCase() + r.tipo.slice(1)}*\n\n${emoji} R$${r.precio}\n${r.descripcion}\n\n¿La confirmamos? Responde *1* 😊`;
    } else {
        msg = "📱 *Tenemos estos tipos de recarga:*\n\n";
        recargas.forEach((r, i) => {
            const emoji = r.tipo === "nacional" ? "🇨🇺" : "🌍";
            msg += `${i + 1}️⃣ *Recarga ${r.tipo.charAt(0).toUpperCase() + r.tipo.slice(1)}*\n`;
            msg += `${emoji} R$${r.precio}\n`;
            msg += `${r.descripcion}\n\n`;
        });
        msg += `¿Cuál prefieres? Responde ${recargas.map((_, i) => `*${i + 1}*`).join(" o ")} 😊`;
    }

    await guardarCliente({ phone, estado: "seleccionando_recarga", fechaEstado: new Date().toISOString() });
    await enviarSeguro(phone, msg);
    return msg;
}

// ─────────────────────────────────────────
// SELECCIÓN DE TIPO DE RECARGA
// ─────────────────────────────────────────

async function seleccionarRecarga(phone, opcion) {
    const recargas = await leerRecargas();
    const idx = parseInt(opcion) - 1;
    const recargaElegida = recargas[idx];
    if (!recargaElegida) {
        const opcionesTxt = recargas.map((_, i) => `*${i + 1}*`).join(" o ") || "una opción válida";
        await enviarSeguro(phone, `Responde ${opcionesTxt} 😊`);
        return "";
    }
    await guardarCliente({
        phone,
        monto: recargaElegida.precio,
        tipo: `recarga_${recargaElegida.tipo}`,
        estado: "aguardando_numero_recarga",
        fechaEstado: new Date().toISOString()
    });
    await enviarSeguro(phone, `Perfecto 😊\n\n¿Cuál es el número cubano a recargar?\n\nEjemplo: 5XXXXXXX`);
    return "";
}

// ─────────────────────────────────────────
// NÚMERO CUBANO PARA RECARGA
// ─────────────────────────────────────────

// IMPORTANTE: si el cliente empezó esta recarga y el administrador
// desactivó esa modalidad en el medio (dashboard), no se completa la
// operación basándose en el contexto viejo -- se revalida contra la
// configuración ACTUAL antes de seguir.
async function procesarNumeroRecarga(phone, soloNums, esEs) {
    const clienteActual = await obtenerCliente(phone);
    const tipoElegido = String(clienteActual?.tipo_favorito || "").replace("recarga_", "");
    const recargasActivas = await leerRecargas();
    const sigueActiva = recargasActivas.some(r => r.tipo === tipoElegido);

    if (!sigueActiva) {
        const msg = esEs
            ? "Esa modalidad de recarga ya no está disponible en este momento 😊"
            : "Essa modalidade de recarga não está mais disponível 😊";
        await enviarSeguro(phone, msg);
        return await mostrarMenuRecargas(phone);
    }

    await guardarCliente({
        phone,
        tarjeta: soloNums,
        estado: "aguardando_comprovante",
        fechaEstado: new Date().toISOString(),
        fechaPix: new Date().toISOString()
    });
    const cli = await obtenerCliente(phone);
    return await enviarPIX(phone, cli, esEs);
}

module.exports = {
    leerRecargas,
    mostrarMenuRecargas,
    seleccionarRecarga,
    procesarNumeroRecarga
};
