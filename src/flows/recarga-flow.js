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

async function mostrarMenuRecargas(phone) {
    const recargas = await leerRecargas();
    if (recargas.length === 0) {
        await enviarSeguro(phone, "Por el momento no tenemos recargas disponibles. Pregunta a Yordanys 😊");
        return "";
    }
    let msg = "📱 *Tenemos dos tipos de recarga:*\n\n";
    recargas.forEach((r, i) => {
        const emoji = r.tipo === "nacional" ? "🇨🇺" : "🌍";
        msg += `${i + 1}️⃣ *Recarga ${r.tipo.charAt(0).toUpperCase() + r.tipo.slice(1)}*\n`;
        msg += `${emoji} R$${r.precio}\n`;
        msg += `${r.descripcion}\n\n`;
    });
    msg += "¿Cuál prefieres? Responde *1* o *2* 😊";
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
        await enviarSeguro(phone, "Responde 1 o 2 😊");
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

async function procesarNumeroRecarga(phone, soloNums, esEs) {
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
