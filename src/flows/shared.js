
"use strict";

const { enviarConDelay }  = require("../services/zapi");
const { limpiarSesionDB } = require("../services/customer-memory");
const env                 = require("../config/env");

// ─────────────────────────────────────────
// CONSTANTES DE NEGOCIO
// ─────────────────────────────────────────

const DOS_HORAS = 2 * 60 * 60 * 1000;

function getPIXKey()     { return env.PIX_KEY         || ""; }
function getPIXHolder()  { return env.PIX_HOLDER_NAME || ""; }
function getPIXBank()    { return env.PIX_BANK        || ""; }
function getPIXImage()   { return env.PIX_IMAGE_URL   || ""; }
function getAdminPhone() { return env.ADMIN_PHONE     || ""; }
function getPIXAliases() {
    return (env.PIX_HOLDER_ALIASES || "").split("|").map(s => s.trim()).filter(Boolean);
}

// ─────────────────────────────────────────
// GATILLOS
// ─────────────────────────────────────────

const gatilhos = [
    "remesa","transferencia","transferir","enviar dinero","mandar dinero",
    "quiero enviar","necesito enviar","quiero mandar","enviar a cuba","mandar a cuba",
    "dinero para cuba","tasa","cotizacion","cotizar","a como esta","a cuanto esta",
    "cuanto recibe","cuanto llega","cuanto pagan","cuanto da","el cambio","cambio de hoy",
    "cup","peso cubano","pesos cubanos","usd","dolar","dolares",
    "recarga","saldo","pix","clave pix","qr pix","tarjeta","bpa","bandec","metropolitano",
    "como envio","como mando","quiero cotizar","pasame el pix","mandame el pix",
    "me interesa","quiero pagar","voy a pagar","pasar dinero","mandar plata","enviar plata",
    "mi familia en cuba","ayuda a mi familia","enviar para cuba","mandar para cuba",
    "hacer una remesa","necesito una remesa","quiero hacer un envio","quiero mandar dinero",
    "recargar","recarga etecsa","recarga cuba","quiero recargar","necesito recargar",
    "recarga para cuba","recarga de telefono","recargar telefono","recarga movil"
];

const palabrasNegocio = [
    "cuba","cup","usd","mlc","transferencia","remesa","pix","recarga","etecsa","tarjeta"
];

const triggersCubaBrasil = [
    "tengo cup","vender cup","cup por reales","dinero en cuba","traer para brasil",
    "traer dinero","enviar desde cuba","pesos cubanos","cambiar cup","cambio de cup",
    "cup a reales","cup a brl","tengo pesos cubanos","vendo cup","vendo pesos"
];

const confirmaOperacion = [
    "si","sí","ok","dale","vamos","quiero hacerlo","continuar","deseo continuar",
    "de acuerdo","hagamoslo","hagámoslo","continuemos","perfecto","listo","va",
    "claro","seguro","exacto","adelante","procede","procedemos","quiero","acepto"
];

// ─────────────────────────────────────────
// MENSAJES
// ─────────────────────────────────────────

const CIERRES_COT = [
    "¿Hacemos la operación ahora? 💸",
    "¿Te envío el PIX para que puedas pagar? 😊",
    "¿Continuamos? Solo necesito el comprobante después 👌",
    "¿Procedemos? Si ya tienes la tarjeta lista, es un momento 🚀",
    "¿Lo cerramos ahora? El proceso es rápido 😊",
    "¿Quieres que te mande la clave PIX ya? 💸",
    "¿Seguimos? Te mando los datos para pagar 👇"
];

const CIERRES_COT_PT = [
    "Fazemos agora? 💸",
    "Posso te mandar o PIX para pagar? 😊",
    "Continuamos? Só preciso do comprovante depois 👌",
    "Seguimos? Se já tem o cartão, é rapidinho 🚀",
    "Fechamos agora? O processo é bem rápido 😊",
    "Quer que eu mande a chave PIX já? 💸",
    "Vamos? Te mando os dados para pagar 👇"
];

const CONFIRMA_TARJETA_SIN_MONTO = [
    "¡Listo! 💳 ¿Cuánto vas a enviar?",
    "¡Tarjeta guardada! 💳 ¿Qué monto quieres mandar?",
    "¡Anotado! 💳 ¿Cuánto vas hoy?",
    "Perfecto, ya tengo la tarjeta 💳 ¿Cuánto quieres enviar?",
    "¡Ya la tengo! 💳 Dime el monto y arrancamos 😊"
];

const CONFIRMA_TARJETA_SIN_MONTO_PT = [
    "Pronto! 💳 Quanto vai enviar?",
    "Cartão salvo! 💳 Qual o valor?",
    "Anotado! 💳 Quanto vai mandar hoje?",
    "Perfeito, já tenho o cartão 💳 Me diz o valor 😊",
    "Já tenho! 💳 Me fala o valor e a gente resolve 😊"
];

const ESPERA_COMPROBANTE_ES = [
    "Perfecto, mándame el comprobante cuando puedas 📎",
    "¡Genial! En cuanto me llegue el comprobante lo proceso 📎",
    "Listo, cuando hagas el pago mándame la foto o PDF 📎",
    "Cuando transfieras mándame el comprobante y lo reviso enseguida 📎"
];

const ESPERA_COMPROBANTE_PT = [
    "Perfeito, me manda o comprovante quando puder 📎",
    "Ótimo! Assim que chegar o comprovante eu processo 📎",
    "Certo, quando fizer o pagamento me manda a foto ou PDF 📎",
    "Quando transferir me manda o comprovante e eu revejo já 📎"
];

const TARJETA_ILEGIBLE = [
    "No pude leer bien la imagen 📸\n\nMándame otra más clara o escríbeme los 16 dígitos.",
    "La imagen no salió bien 📸\n\nPrueba con otra foto o escríbeme los números directamente.",
    "No logré capturar los datos de la tarjeta 📸\n\n¿Puedes mandarme otra foto o escribir los 16 dígitos?"
];

// ─────────────────────────────────────────
// UTILIDADES
// ─────────────────────────────────────────

function pick(arr)           { return arr[Math.floor(Math.random() * arr.length)]; }
function pickL(es, pt, lang) { return pick(lang === "pt" ? pt : es); }

function norm(t) {
    return String(t || "").toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function fmt(n) { return Number(n).toLocaleString("es-ES"); }

function parseGPT(t) {
    try {
        return JSON.parse(
            String(t || "").replace(/```json/gi,"").replace(/```/g,"").trim()
        );
    } catch { return {}; }
}

function esPDF(url) {
    if (!url) return false;
    const u = url.toLowerCase();
    return u.includes(".pdf") || u.includes("mimetype=pdf") || u.includes("type=pdf");
}

async function enviarSeguro(phone, msg, delay = null, jitter = true) {
    if (!msg || !phone) return;
    if (jitter) await new Promise(r => setTimeout(r, Math.random() * 400));
    await enviarConDelay(phone, msg, delay);
}

async function limpiarSesion(phone) { await limpiarSesionDB(phone); }

module.exports = {
    DOS_HORAS,
    getPIXKey, getPIXHolder, getPIXBank, getPIXImage, getAdminPhone, getPIXAliases,
    gatilhos, palabrasNegocio, triggersCubaBrasil, confirmaOperacion,
    CIERRES_COT, CIERRES_COT_PT,
    CONFIRMA_TARJETA_SIN_MONTO, CONFIRMA_TARJETA_SIN_MONTO_PT,
    ESPERA_COMPROBANTE_ES, ESPERA_COMPROBANTE_PT,
    TARJETA_ILEGIBLE,
    pick, pickL, norm, fmt, parseGPT, esPDF, enviarSeguro, limpiarSesion
};
