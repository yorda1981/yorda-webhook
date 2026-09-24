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
function getEntregaContactPhone() { return env.ENTREGA_CONTACT_PHONE || ""; }
function getPIXAliases() {
    return (env.PIX_HOLDER_ALIASES || "").split("|").map(s => s.trim()).filter(Boolean);
}

// Destinatarios internos del CRM de Entregas (ADMIN_PHONE + ENTREGA_CONTACT_PHONE),
// deduplicados por dígitos -- Z-API acepta números con formatos distintos, pero
// dos formatos que normalizan al mismo dígito son la MISMA persona y solo deben
// recibir el aviso una vez. Se conserva el primer formato configurado para el
// envío; nunca se colapsan números con dígitos realmente diferentes. Único punto
// de esta lógica -- reusado tanto por el aviso de entrega nueva
// (pedido-web-flow.js) como por el aviso de entrega ENTREGADO (entregas-coordinator.js).
function destinatariosInternosEntregasDetallados() {
    const destinatarios = [];
    const vistos = new Set();
    for (const [rol, numero] of [["ADMIN", getAdminPhone()], ["ENTREGA_CONTACT", getEntregaContactPhone()]].filter(([, numero]) => numero)) {
        const normalizado = String(numero).replace(/\D/g, "");
        const clave = normalizado || String(numero).trim();
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        destinatarios.push({ phone: numero, rol });
    }
    return destinatarios;
}

function destinatariosInternosEntregas() {
    return destinatariosInternosEntregasDetallados().map(({ phone }) => phone);
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
    "recarga para cuba","recarga de telefono","recargar telefono","recarga movil",

    // Portugués — frases específicas de intención de negocio (no palabras sueltas,
    // para no activar el bot con mensajes genéricos que no son de Yorda Envíos)
    "quero enviar dinheiro","preciso enviar dinheiro","quero mandar dinheiro",
    "preciso mandar dinheiro","enviar dinheiro para cuba","mandar dinheiro para cuba",
    "dinheiro para cuba","minha familia em cuba","minha família em cuba",
    "ajudar minha familia em cuba","quanto custa enviar","quanto custa mandar",
    "qual a taxa de hoje","qual a taxa hoje","como faço para enviar",
    "quero fazer uma remessa","preciso fazer uma remessa","quero cotizar",
    "quanto fica o envio","quero recarregar","preciso recarregar","recarregar etecsa"
];

const palabrasNegocio = [
    "cuba","cup","usd","mlc","transferencia","remesa","pix","recarga","etecsa","tarjeta",
    "entrega","entregar","domicilio","municipio"
];

const triggersCubaBrasil = [
    "tengo cup","vender cup","cup por reales","dinero en cuba","traer para brasil",
    "traer dinero","enviar desde cuba","pesos cubanos","cambiar cup","cambio de cup",
    "cup a reales","cup a brl","tengo pesos cubanos","vendo cup","vendo pesos"
];

const confirmaOperacion = [
    "si","sí","ok","dale","vamos","quiero hacerlo","continuar","deseo continuar",
    "de acuerdo","hagamoslo","hagámoslo","continuemos","perfecto","listo","va",
    "claro","seguro","exacto","adelante","procede","procedemos","quiero","acepto",
    // Portugués -- antes un "Sim" tras la cotización no confirmaba nada y el
    // cliente quedaba sin respuesta.
    "sim","pode","pode sim","claro que sim","certo","fechado","bora","isso","isso mesmo",
    "pode ser","com certeza","quero sim","vamos sim"
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
    "¡Ya la tengo! 💳 Dime el monto y arrancamos 😊",
    "Tarjeta lista 💳 ¿Cuánto mandamos?",
    "¡Guardada! 💳 ¿Con cuánto seguimos?"
];

const CONFIRMA_TARJETA_SIN_MONTO_PT = [
    "Pronto! 💳 Quanto vai enviar?",
    "Cartão salvo! 💳 Qual o valor?",
    "Anotado! 💳 Quanto vai mandar hoje?",
    "Perfeito, já tenho o cartão 💳 Me diz o valor 😊",
    "Já tenho! 💳 Me fala o valor e a gente resolve 😊",
    "Cartão pronto 💳 Quanto mandamos?",
    "Salvo! 💳 Seguimos com qual valor?"
];

const ESPERA_COMPROBANTE_ES = [
    "Perfecto, mándame el comprobante cuando puedas 📎",
    "¡Genial! En cuanto me llegue el comprobante lo proceso 📎",
    "Listo, cuando hagas el pago mándame la foto o PDF 📎",
    "Cuando transfieras mándame el comprobante y lo reviso enseguida 📎",
    "Dale, me avisas con la foto del comprobante en cuanto pagues 📎",
    "Ok, quedo atento al comprobante 📎"
];

const ESPERA_COMPROBANTE_PT = [
    "Perfeito, me manda o comprovante quando puder 📎",
    "Ótimo! Assim que chegar o comprovante eu processo 📎",
    "Certo, quando fizer o pagamento me manda a foto ou PDF 📎",
    "Quando transferir me manda o comprovante e eu revejo já 📎",
    "Beleza, me avisa com a foto assim que pagar 📎",
    "Ok, fico esperando o comprovante 📎"
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

// Lee cliente.tarjetas de forma segura, sea que la columna en PostgreSQL
// devuelva un array ya parseado (json/jsonb) o un string JSON (text).
// Antes esto se asumía siempre-array con Array.isArray(), y si la columna
// era texto, la selección de tarjeta guardada fallaba silenciosamente.
function parseTarjetas(raw) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string" && raw.trim()) {
        try {
            const p = JSON.parse(raw);
            return Array.isArray(p) ? p : [];
        } catch { return []; }
    }
    return [];
}

async function enviarSeguro(phone, msg, delay = null, jitter = true, transport = enviarConDelay) {
    if (!msg || !phone) return;
    if (jitter) await new Promise(r => setTimeout(r, Math.random() * 400));
    return await transport(phone, msg, delay);
}

async function limpiarSesion(phone) { await limpiarSesionDB(phone); }

module.exports = {
    DOS_HORAS,
    getPIXKey, getPIXHolder, getPIXBank, getPIXImage, getAdminPhone, getEntregaContactPhone, getPIXAliases,
    destinatariosInternosEntregas, destinatariosInternosEntregasDetallados,
    gatilhos, palabrasNegocio, triggersCubaBrasil, confirmaOperacion,
    CIERRES_COT, CIERRES_COT_PT,
    CONFIRMA_TARJETA_SIN_MONTO, CONFIRMA_TARJETA_SIN_MONTO_PT,
    ESPERA_COMPROBANTE_ES, ESPERA_COMPROBANTE_PT,
    TARJETA_ILEGIBLE,
    pick, pickL, norm, fmt, parseGPT, esPDF, parseTarjetas, enviarSeguro, limpiarSesion
};
