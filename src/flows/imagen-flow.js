"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const pdfParse  = require("pdf-parse");
const env       = require("../config/env");
const { parseGPT, getPIXKey, getPIXAliases } = require("./shared");

const anthropic = new Anthropic({
    apiKey:     env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY,
    timeout:    60000,   // 60 segundos — imágenes base64 necesitan más tiempo
    maxRetries: 0        // reintentos los manejamos nosotros
});

const MODEL_VISION = "claude-opus-4-6";   // OCR imágenes — modelo actual
const MODEL_CHAT   = "claude-haiku-4-5-20251001";  // Asistente — más barato

// ─────────────────────────────────────────
// RETRY
// ─────────────────────────────────────────
async function conReintento(fn, intentos = 3, delayMs = 2000) {
    for (let i = 0; i < intentos; i++) {
        try {
            return await fn();
        } catch (e) {
            const esRetriable = e.status === 529 || e.status === 503 ||
                                e.status === 429 || e.message?.includes("overloaded") ||
                                e.message?.includes("timeout") || e.message?.includes("ECONNRESET");
            if (esRetriable && i < intentos - 1) {
                const espera = delayMs * Math.pow(2, i);
                console.warn(`⚠️ Claude OCR fallo (intento ${i+1}/${intentos}) — reintentando en ${espera/1000}s...`);
                await new Promise(r => setTimeout(r, espera));
                continue;
            }
            throw e;
        }
    }
}

// ─────────────────────────────────────────
// PROMPTS OCR
// ─────────────────────────────────────────

function promptTarjeta() {
    return `Analiza esta imagen. ¿Es una tarjeta bancaria cubana con 16 dígitos?
Responde SOLO en JSON, sin texto extra ni markdown.

SI es tarjeta cubana:
{"tipo":"tarjeta","tarjeta":"16DIGITOS","titular":"NOMBRE","banco":"bpa|bandec|metropolitano|clasica_incentivos|otro","valida":true}

SI NO es tarjeta cubana: {"tipo":"otro"}

TARJETAS CUBANAS VÁLIDAS:
- BPA: logo azul/verde, "banco popular de ahorro"
- Bandec: logo rojo/naranja, a veces "PREPAID CARD" con playa
- Metropolitano: logo azul
- Clásica Tarjeta de Incentivos: fondo azul oscuro geométrico, texto "Clásica" cursiva dorada → banco:"clasica_incentivos"

EXTRACCIÓN:
- 16 dígitos sin espacios → "9205129976352031"
- Si borrosa/girada → intenta igual; 12+ dígitos visibles → valida:false
- Titular en mayúsculas en la parte inferior

NO es tarjeta cubana → {"tipo":"otro"}:
- Tarjetas brasileñas (Visa/Master/Elo/Nubank), documentos, billetes, reverso`;
}

function promptUnificado(key, aliases) {
    return `Analiza esta imagen. Puede ser: tarjeta bancaria cubana, comprobante PIX brasileño, u otro.
Responde SOLO en JSON válido, sin texto extra ni markdown.

TARJETA CUBANA: {"tipo":"tarjeta","tarjeta":"16DIGITOS","titular":"NOMBRE","banco":"bpa|bandec|metropolitano|clasica_incentivos|otro","valida":true}
COMPROBANTE PIX: {"tipo":"comprovante_pix","valor":200,"fecha":"DD/MM/AAAA","hora":"HH:MM","banco":"banco pagador","destinatario":"nombre","destino_correcto":true,"valido":true}
OTRO: {"tipo":"otro"}

TARJETAS CUBANAS: BPA (azul/verde), Bandec (rojo/naranja, a veces playa), Metropolitano, Clásica Tarjeta de Incentivos (azul oscuro geométrico, cursiva dorada→"clasica_incentivos"). 16 dígitos sin espacios. Titular abajo en mayúsculas. NO: Visa/Master/Elo/documentos/billetes/reverso.

COMPROBANTE PIX (3 formatos): (1)"Pix enviado"/"Transferência" con valor+fecha; (2)detalle con "Chave Pix"/"Pagador"/"Instituição"/ID "E+números"; (3)recibo con "Dados da transação"/"Data do débito". valor=número puro. destino_correcto=true si chave="${key}" O destinatario="${aliases}" O instituição="NU PAGAMENTOS".`;
}

function promptPDF(key, aliases) {
    return `Analiza este texto de un comprobante de pago PIX. Responde SOLO en JSON válido, sin texto extra.

{"tipo":"comprovante_pdf","valor":200,"fecha":"DD/MM/AAAA","hora":"HH:MM","banco":"banco pagador","destinatario":"nombre","destino_correcto":true,"valido":true}

valor=número puro (200.50). destino_correcto=true si chave="${key}" O destinatario="${aliases}" O instituição="NU PAGAMENTOS". datos faltantes=null.`;
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

async function urlToBase64(url) {
    const resp = await fetch(url);
    const buf  = Buffer.from(await resp.arrayBuffer());
    return buf.toString("base64");
}

function mimeTypeFromUrl(url) {
    const u = url.toLowerCase();
    if (u.includes(".png"))  return "image/png";
    if (u.includes(".webp")) return "image/webp";
    if (u.includes(".gif"))  return "image/gif";
    return "image/jpeg";
}

// ─────────────────────────────────────────
// OCR — Imagen con Claude Vision
// ─────────────────────────────────────────

async function detectarImagenUnificada(imageUrl, contexto = "auto") {
    try {
        const key     = getPIXKey();
        const aliases = getPIXAliases().join("|");
        const promptTexto = contexto === "tarjeta"
            ? promptTarjeta()
            : promptUnificado(key, aliases);

        const base64   = await urlToBase64(imageUrl);
        const mimeType = mimeTypeFromUrl(imageUrl);

        const response = await conReintento(() => anthropic.messages.create({
            model:      MODEL_VISION,
            max_tokens: 256,
            messages: [{
                role: "user",
                content: [
                    { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
                    { type: "text", text: promptTexto }
                ]
            }]
        }));

        const texto = response.content?.[0]?.text || "";
        console.log(`🔍 OCR Claude: ${texto.substring(0, 120)}`);
        return parseGPT(texto);
    } catch (e) {
        console.error("❌ OCR Claude:", e.message);
        return { tipo: "otro" };
    }
}

// ─────────────────────────────────────────
// OCR — PDF con Claude
// ─────────────────────────────────────────

async function detectarComprobantePDF(pdfUrl) {
    try {
        const resp     = await fetch(pdfUrl);
        const buf      = Buffer.from(await resp.arrayBuffer());
        const { text } = await pdfParse(buf);

        const key     = getPIXKey();
        const aliases = getPIXAliases().join("|");

        const response = await conReintento(() => anthropic.messages.create({
            model:      MODEL_VISION,
            max_tokens: 256,
            messages: [{
                role:    "user",
                content: promptPDF(key, aliases) + `\n\nTexto del comprobante:\n${text.substring(0, 3000)}`
            }]
        }));

        const texto = response.content?.[0]?.text || "";
        return parseGPT(texto);
    } catch (e) {
        console.error("❌ PDF Claude:", e.message);
        return {};
    }
}

// ─────────────────────────────────────────
// ASISTENTE — Claude conversacional
// ─────────────────────────────────────────

function buildSystemPrompt() {
    return `Eres Yorda, asistente virtual de un servicio de remesas entre Brasil y Cuba. Atiendes en español o portugués según el cliente. Eres cálida, directa y profesional.

REGLA PRINCIPAL: Si el mensaje NO tiene relación con envíos de dinero, remesas, tasas, PIX, tarjetas cubanas, Cuba, recargas ETECSA → responde ÚNICAMENTE: IGNORAR

EL SERVICIO: Cliente paga en reales (BRL) por PIX → familia recibe en Cuba en tarjeta bancaria cubana.

MONEDAS:
- BRL: lo que paga el cliente
- CUP (peso cubano): lo que recibe en Cuba
- USD: modalidad en dólares (tarjetas Clásica o Prepago)
- MLC: moneda digital cubana similar al dólar, precio en reales

TARJETAS CUBANAS: BPA, Bandec, Metropolitano, Clásica Tarjeta de Incentivos. Tienen 16 dígitos.

PREGUNTAS FRECUENTES:
- "¿Es seguro?" → "Llevamos tiempo ayudando a familias cubanas en Brasil, sin problemas 😊 ¿Cuánto quieres enviar?"
- "¿Cómo funciona?" → "Tú pagas por PIX y nosotros transferimos a la tarjeta en Cuba. Rápido y seguro 💪"
- "¿Cuánto tarda?" → "Normalmente entre 1 y 24h según la conectividad en Cuba 😊"
- "¿Qué es MLC?" → "MLC es similar al dólar en Cuba, se usa en tiendas en divisa 😊"
- "¿MLC es la de dólares?" → "Sí, similar al dólar en Cuba 😊"

DERIVAR A YORDANYS: problemas con operaciones, reclamos, errores de monto.
Frase: "Yordanys revisa eso directamente 😊 Aguarda un momento."

FORMATO: Máximo 3 líneas. Terminar con pregunta o acción. Un emoji máximo. NUNCA inventar tasas. NUNCA decir que eres IA.`;
}

const historialConv = new Map();

async function llamarAsistente(mensajeUsuario, lastResponseId = null, contextoCliente = null) {
    try {
        const phoneKey = contextoCliente?.phone || "default";
        let historial  = historialConv.get(phoneKey) || [];

        // Enriquecer con contexto del cliente
        let msgFinal = mensajeUsuario;
        if (contextoCliente) {
            const partes = [];
            if (contextoCliente.nombre)       partes.push(`Cliente: ${contextoCliente.nombre}`);
            if (contextoCliente.idioma)       partes.push(`Idioma: ${contextoCliente.idioma === "pt" ? "portugués" : "español"}`);
            if (contextoCliente.ultimo_monto) partes.push(`Último monto: R$${contextoCliente.ultimo_monto}`);
            if (partes.length) msgFinal = `[${partes.join(", ")}]\n\n${mensajeUsuario}`;
        }

        // Agregar al historial
        historial.push({ role: "user", content: msgFinal });
        if (historial.length > 20) historial = historial.slice(-20);

        const response = await conReintento(() => anthropic.messages.create({
            model:      MODEL_CHAT,
            max_tokens: 300,
            system:     buildSystemPrompt(),
            messages:   historial
        }));

        const texto = response.content?.[0]?.text?.trim() || "";

        // Guardar respuesta en historial
        historial.push({ role: "assistant", content: texto });
        historialConv.set(phoneKey, historial);
        setTimeout(() => historialConv.delete(phoneKey), 60 * 60 * 1000);

        return { texto, responseId: null };
    } catch (e) {
        console.error("❌ Asistente Claude:", e.message);
        return { texto: "", responseId: null };
    }
}

module.exports = { detectarImagenUnificada, detectarComprobantePDF, llamarAsistente };
