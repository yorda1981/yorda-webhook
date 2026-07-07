"use strict";

const pool              = require("../../db");
const { calcularOperacion }  = require("../services/calculator");
const { guardarCliente }     = require("../services/customer-memory");
const crm                    = require("../services/crm");
const {
    enviarSeguro, fmt, pickL,
    CIERRES_COT, CIERRES_COT_PT
} = require("./shared");

// ─────────────────────────────────────────
// HELPERS DB
// ─────────────────────────────────────────

async function leerOferta() {
    try {
        const r = await pool.query("SELECT * FROM ofertas WHERE activa = true AND (vence_at IS NULL OR vence_at > NOW()) LIMIT 1");
        return r.rows[0]?.texto || null;
    } catch { return null; }
}

async function leerTasas() {
    try {
        const r = await pool.query("SELECT * FROM rates LIMIT 1");
        return r.rows[0] || null;
    } catch { return null; }
}

// ─────────────────────────────────────────
// COTIZACIÓN BRL → CUP
// ─────────────────────────────────────────

async function cotizarBRL(phone, pushName, valorFinal, lang) {
    const r = await calcularOperacion({ tipo: "brl_cup", valor: valorFinal });
    if (!r) return null;

    await guardarCliente({
        phone, nombre: pushName, monto: valorFinal, tipo: "brl_cup",
        estado: "cotizacion_realizada",
        fechaEstado: new Date().toISOString(),
        fechaCotizacion: new Date().toISOString()
    });
    await crm.onCotizacion(phone, lang);

    let tip = "";
    if (valorFinal < 100)       tip = "\n\n💡 Con R$100+ la tasa mejora.";
    else if (valorFinal < 500)  tip = "\n\n🔥 Con R$500+ la tasa sube otro escalón.";
    else if (valorFinal < 1000) tip = "\n\n🚀 Con R$1000+ obtienes la mejor tasa.";

    const oferta    = await leerOferta();
    const ofertaMsg = oferta ? `\n\n🔥 *OFERTA:* ${oferta}` : "";
    const res = `💵 R$${valorFinal} = ${fmt(r.cup)} CUP 🇨🇺${tip}${ofertaMsg}\n\n${pickL(CIERRES_COT, CIERRES_COT_PT, lang)}`;
    await enviarSeguro(phone, res);
    return res;
}

// ─────────────────────────────────────────
// COTIZACIÓN USD → CUP
// ─────────────────────────────────────────

async function cotizarUSD(phone, pushName, valorFinal, tipo, lang, esEs) {
    const r = await calcularOperacion({ tipo, valor: valorFinal });
    if (!r) return null;

    await guardarCliente({
        phone, nombre: pushName, monto: valorFinal, tipo,
        estado: "cotizacion_realizada",
        fechaEstado: new Date().toISOString(),
        fechaCotizacion: new Date().toISOString()
    });
    await crm.onCotizacion(phone, lang);

    const oferta    = await leerOferta();
    const ofertaMsg = oferta ? `\n\n🔥 *OFERTA:* ${oferta}` : "";
    const res = `💵 ${valorFinal} USD = R$${fmt(r.cup)} 🇧🇷${ofertaMsg}\n\n${pickL(CIERRES_COT, CIERRES_COT_PT, lang)}`;
    await enviarSeguro(phone, res);
    return res;
}

// Pregunta tipo USD cuando no está especificado
async function preguntarTipoUSD(phone, pushName, valorFinal, lang, esEs) {
    const msgTipo = esEs
        ? `💵 ${valorFinal} USD — ¿es para tarjeta Clásica o Prepago? 😊\n\n1️⃣ Clásica (BPA/Bandec)\n2️⃣ Prepago (Nauta/Internacional)`
        : `💵 ${valorFinal} USD — é para cartão Clássico ou Pré-pago? 😊\n\n1️⃣ Clássico (BPA/Bandec)\n2️⃣ Pré-pago (Nauta/Internacional)`;
    await guardarCliente({
        phone, nombre: pushName, monto: valorFinal, tipo: "usd_pendiente_tipo",
        estado: "cotizacion_realizada",
        fechaEstado: new Date().toISOString(),
        fechaCotizacion: new Date().toISOString()
    });
    await crm.onCotizacion(phone, lang);
    await enviarSeguro(phone, msgTipo);
    return msgTipo;
}

// ─────────────────────────────────────────
// COTIZACIÓN MLC → CUP
// ─────────────────────────────────────────

async function cotizarMLC(phone, pushName, valorFinal, lang) {
    const r = await calcularOperacion({ tipo: "mlc", valor: valorFinal });
    if (!r || r.tasa <= 0) {
        const msg = lang === "pt"
            ? "O MLC não está disponível no momento. Me diz quanto quer em reais ou USD 😊"
            : "El MLC no está disponible por ahora. Dime cuánto quieres en reales o USD 😊";
        await enviarSeguro(phone, msg);
        return msg;
    }
    const oferta    = await leerOferta();
    const ofertaMsg = oferta ? `\n\n🔥 *OFERTA:* ${oferta}` : "";
    const res = lang === "pt"
        ? `💳 ${valorFinal} MLC = R$${fmt(r.cup)} 🇧🇷${ofertaMsg}\n\n${pickL(CIERRES_COT, CIERRES_COT_PT, lang)}`
        : `💳 ${valorFinal} MLC = R$${fmt(r.cup)} 🇧🇷${ofertaMsg}\n\n${pickL(CIERRES_COT, CIERRES_COT_PT, lang)}`;
    await guardarCliente({
        phone, nombre: pushName, monto: valorFinal, tipo: "mlc",
        estado: "cotizacion_realizada",
        fechaEstado: new Date().toISOString(),
        fechaCotizacion: new Date().toISOString()
    });
    await crm.onCotizacion(phone, lang);
    await enviarSeguro(phone, res);
    return res;
}

// Consulta tasa MLC sin monto
async function tasaMLC(phone, lang) {
    const t = await leerTasas();
    const tasaMlc = Number(t?.mlc || 0);
    if (tasaMlc > 0) {
        const msg = lang === "pt"
            ? `💳 MLC hoje: *R$${tasaMlc}* por MLC\n\nQual o valor que quer enviar? 😊`
            : `💳 MLC hoy: *R$${tasaMlc}* por MLC\n\n¿Cuánto quieres enviar? 😊`;
        await enviarSeguro(phone, msg);
        return msg;
    }
    return null;
}

// ─────────────────────────────────────────
// CÁLCULO INVERSO: CUP → Reales
// "para que lleguen 85 mil, cuánto pago?"
// ─────────────────────────────────────────

function detectarCUPInverso(txt) {
    const patrones = [
        /(\d[\d.,]*)\s*(mil|k)\s*(cup|cuc|pesos?\s*cubanos?|pesos?)\b/i,
        /\b(cup|pesos?\s*cubanos?)\s*(\d[\d.,]*)\s*(mil|k)?/i,
        /(\d{4,6})\s*(cup|cuc|pesos?\s*cubanos?)/i,
        /(?:lleguen?|recib[ae]n?|chegar?|chegue)\s+(\d[\d.,]*)\s*(mil|k)?/i,
        /para\s+(\d[\d.,]*)\s*(mil|k)?\s*(?:cup|cuc|pesos?|$)/i,
    ];

    const esInverso =
        /(cuanto|quanto|cu[aá]nto)\s+(es|son|seria|ser[ií]a|cuesta|vale|pago|envio|mando|preciso|necesito).{0,40}(cup|cuc|pesos?\s*cubanos?|mil)/i.test(txt) ||
        /(cup|cuc|pesos?\s*cubanos?).{0,40}(reais?|reales?|brl|r\$|en reais?|em reais?)/i.test(txt) ||
        /(que\s+)?(lleguen?|recib[ae]n?|chegar?|chegue).{0,20}(mil|\d{4,6})/i.test(txt) ||
        /(para\s+)?(que\s+)?(lleguen?|recib[ae]n?)/i.test(txt) ||
        /(cuanto|quanto)\s+(real|reais|pago|mando|envio|preciso|necesito).{0,40}(mil|\d{3,6})/i.test(txt) ||
        /(quanto\s+preciso|quanto\s+envio|quanto\s+mando|cuanto\s+necesito|cuanto\s+pago)/i.test(txt);

    if (!esInverso) return null;

    let montoCUP = null;
    for (const p of patrones) {
        const m = txt.match(p);
        if (m) {
            const numStr = (m[1] || m[2] || "").replace(/[.,]/g, "");
            const esMil  = /mil|k/i.test(m[2] || m[3] || "");
            const num    = Number(numStr);
            if (num > 0) { montoCUP = esMil ? num * 1000 : num; break; }
        }
    }

    if (!montoCUP) {
        const m2 = txt.match(/(\d+)\s*(mil|k)/i);
        if (m2) montoCUP = Number(m2[1]) * 1000;
        else {
            const m3 = txt.match(/\b(\d{4,6})\b/);
            if (m3) montoCUP = Number(m3[1]);
        }
    }

    return montoCUP && montoCUP >= 1000 && montoCUP <= 5000000 ? montoCUP : null;
}

async function cotizarCUPInverso(phone, pushName, montoCUP, lang) {
    const t = await leerTasas();
    if (!t) return null;

    const tramos = [
        { min: 0,    max: 99,    tasa: Number(t.brl_0)    },
        { min: 100,  max: 499,   tasa: Number(t.brl_100)  },
        { min: 500,  max: 999,   tasa: Number(t.brl_500)  },
        { min: 1000, max: 999999, tasa: Number(t.brl_1000) },
    ];

    let realesNecesarios = null, tasaUsada = null;
    for (const tr of tramos) {
        const est = montoCUP / tr.tasa;
        if (est >= tr.min && est <= tr.max) {
            realesNecesarios = Math.ceil(est);
            tasaUsada = tr.tasa;
            break;
        }
    }
    if (!realesNecesarios) {
        tasaUsada = Number(t.brl_1000);
        realesNecesarios = Math.ceil(montoCUP / tasaUsada);
    }

    const cupFmt = montoCUP >= 1000
        ? (montoCUP / 1000 % 1 === 0 ? `${montoCUP/1000} mil` : `${(montoCUP/1000).toFixed(1)} mil`)
        : montoCUP.toString();

    const msg = lang === "pt"
        ? `Para chegar *${cupFmt} CUP* em Cuba 🇨🇺\n\nVocê precisa enviar *R$${realesNecesarios}*\n_(taxa: ${tasaUsada} CUP por real)_\n\n${pickL(CIERRES_COT, CIERRES_COT_PT, lang)}`
        : `Para que lleguen *${cupFmt} CUP* en Cuba 🇨🇺\n\nNecesitas enviar *R$${realesNecesarios}*\n_(tasa: ${tasaUsada} CUP por real)_\n\n${pickL(CIERRES_COT, CIERRES_COT_PT, lang)}`;

    await guardarCliente({
        phone, nombre: pushName, monto: realesNecesarios, tipo: "brl_cup",
        estado: "cotizacion_realizada",
        fechaEstado: new Date().toISOString(),
        fechaCotizacion: new Date().toISOString()
    });
    await crm.onCotizacion(phone, lang);
    await enviarSeguro(phone, msg);
    return msg;
}

// ─────────────────────────────────────────
// CONSULTA DE TASAS GENERAL
// ─────────────────────────────────────────

async function consultarTasas(phone) {
    const t = await leerTasas();
    if (!t) return null;
    const msg = `Tasas de hoy 💱\n\n🇧🇷 Reales → CUP\nHasta R$99: ${t.brl_0} CUP\nR$100–499: ${t.brl_100} CUP\nR$500–999: ${t.brl_500} CUP\nR$1000+: ${t.brl_1000} CUP\n\n💵 USD Clásica/Prepago: R$${t.usd1}${t.mlc ? `\n💳 MLC: R$${t.mlc}` : ""}\n\n¿Cuánto quieres enviar? 😊`;
    await enviarSeguro(phone, msg);
    return msg;
}

module.exports = {
    cotizarBRL,
    cotizarUSD,
    preguntarTipoUSD,
    cotizarMLC,
    tasaMLC,
    detectarCUPInverso,
    cotizarCUPInverso,
    consultarTasas,
    leerOferta,
    leerTasas
};
