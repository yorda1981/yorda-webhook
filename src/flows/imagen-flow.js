"use strict";

const OpenAI   = require("openai");
const pdfParse = require("pdf-parse");
const env      = require("../config/env");
const { parseGPT, getPIXKey, getPIXAliases } = require("./shared");

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ─────────────────────────────────────────
// PROMPTS OCR
// ─────────────────────────────────────────

function promptImagen() {
    const aliases = getPIXAliases().join(", ");
    const key     = getPIXKey();
    return `Analiza esta imagen con atención. Puede ser una tarjeta bancaria cubana, un comprobante PIX brasileño, u otra cosa. Responde SOLO en JSON válido, sin texto adicional.

FORMATOS:

TARJETA: {"tipo":"tarjeta","tarjeta":"SOLO16DIGITOS","titular":"NOMBRE COMPLETO","banco":"bandec|bpa|metropolitano|otro","valida":true}
COMPROBANTE: {"tipo":"comprovante_pix","valor":200,"fecha":"DD/MM/AAAA","hora":"HH:MM","banco":"banco origen","destinatario":"nombre","destino_correcto":true,"valido":true}
OTRO: {"tipo":"otro"}

REGLAS TARJETA:
- Tarjetas cubanas (BPA, Bandec, Metropolitano) tienen 16 dígitos en grupos de 4: XXXX XXXX XXXX XXXX
- Extrae SOLO los dígitos sin espacios → exactamente 16 caracteres
- Titular aparece en la parte inferior de la tarjeta
- Banco: identifica por logo o texto (BPA=banco popular de ahorro, Bandec=logo rojo/naranja, Metropolitano)
- Si la imagen está borrosa, girada o es reenvío, igualmente intenta extraer los dígitos visibles
- Si logras ver al menos 12 dígitos, extráelos y pon valida:false

REGLAS COMPROBANTE:
- valor: número puro sin símbolo (200, no "R$200,00")
- destino_correcto=true si destinatario coincide con: ${aliases}
${key ? `- destino_correcto=true si aparece la clave PIX: ${key}` : ""}
- datos faltantes → null

Sin texto extra fuera del JSON.`;
}

function promptPDF() {
    const aliases = getPIXAliases().join(", ");
    const key     = getPIXKey();
    return `Analiza el texto del comprobante. Responde SOLO en JSON.
{"tipo":"comprovante_pdf","valor":200,"fecha":"DD/MM/AAAA","hora":"HH:MM","banco":"banco origen","destinatario":"nombre","destino_correcto":true,"valido":true}
- valor: número puro. datos faltantes → null. Sin texto extra.
- destino_correcto=true si destinatario coincide con: ${aliases}.
${key ? `- destino_correcto=true si el texto contiene: ${key}` : ""}`;
}

// ─────────────────────────────────────────
// OCR — Imagen
// ─────────────────────────────────────────

async function detectarImagenUnificada(imageUrl) {
    try {
        const r = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: [
                { type: "text",      text: promptImagen() },
                { type: "image_url", image_url: { url: imageUrl } }
            ]}],
            max_tokens: 220
        });
        return parseGPT(r.choices?.[0]?.message?.content);
    } catch (e) {
        console.error("❌ OCR:", e.message);
        return { tipo: "otro" };
    }
}

// ─────────────────────────────────────────
// OCR — PDF
// ─────────────────────────────────────────

async function detectarComprobantePDF(pdfUrl) {
    try {
        const resp     = await fetch(pdfUrl);
        const buf      = Buffer.from(await resp.arrayBuffer());
        const { text } = await pdfParse(buf);
        const r = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: promptPDF() + `\n\nTexto:\n${text}` }],
            max_tokens: 200
        });
        return parseGPT(r.choices?.[0]?.message?.content);
    } catch (e) {
        console.error("❌ PDF:", e.message);
        return {};
    }
}

// ─────────────────────────────────────────
// ASISTENTE GPT — fallback conversacional
// ─────────────────────────────────────────

async function llamarAsistente(mensajeUsuario, lastResponseId = null) {
    const response = await openai.responses.create({
        model: "gpt-4o-mini",
        input: mensajeUsuario,
        instructions: `Eres Yorda, asistente virtual de un servicio de remesas Brasil→Cuba. Hablas español o portugués según el cliente. Eres cálida, directa y profesional.

═══════════════════════════════════
REGLA PRINCIPAL
═══════════════════════════════════
Si el mensaje NO tiene relación con: envíos, remesas, tasas, PIX, tarjetas cubanas, Cuba, dinero, recargas ETECSA → responde ÚNICAMENTE: IGNORAR

═══════════════════════════════════
EL SERVICIO
═══════════════════════════════════
- Transferimos dinero de Brasil a Cuba
- El cliente paga en reales brasileños (BRL) por PIX
- El destinatario recibe en Cuba en su tarjeta bancaria cubana
- Bancos cubanos: BPA (Banco Popular de Ahorro), Bandec, Metropolitano
- Las tarjetas cubanas tienen 16 dígitos
- El proceso: cotización → PIX → comprobante → transferencia a Cuba

═══════════════════════════════════
MONEDAS — MUY IMPORTANTE
═══════════════════════════════════
BRL (Reales brasileños): lo que el cliente PAGA
CUP (Pesos cubanos / Moneda Nacional): lo que RECIBE en Cuba
USD (Dólares): otra modalidad de envío
MLC (Moneda Libremente Convertible): moneda digital cubana, similar a USD, para tarjetas MLC/prepago

CONVERSIÓN:
- BRL → CUP: el cliente paga reales, la familia recibe pesos cubanos
- Si el cliente pregunta "300 reales cuántos MLC son" → NO es cotización MLC→CUP, es BRL→MLC (cuántos MLC compra con 300 reales). Deriva a Yordanys para ese cálculo específico.
- Si el cliente pregunta "cuántos reales necesito para X CUP" → es cálculo inverso, el bot lo maneja
- MLC NO es lo mismo que CUP. MLC ≈ USD en Cuba

═══════════════════════════════════
PREGUNTAS FRECUENTES — RESPUESTAS EXACTAS
═══════════════════════════════════
¿Qué es MLC? → "MLC es la Moneda Libremente Convertible en Cuba, similar al dólar. Se usa en tiendas en divisas y tarjetas prepago. ¿Quieres enviar MLC o pesos cubanos (CUP)? 😊"

¿MLC es la de dólares? → "Sí, MLC es similar al dólar en Cuba. Se usa en las tiendas en divisa. ¿Quieres enviar MLC? 😊"

¿Cuánto tarda? → "Normalmente entre 1 y 24h según la conectividad en Cuba. Te avisamos cuando se complete 😊"

¿Es seguro? → "Llevamos tiempo ayudando a familias cubanas en Brasil, sin problemas 😊 ¿Cuánto quieres enviar?"

¿Cómo funciona? → "Tú pagas por PIX aquí en Brasil y nosotros transferimos a la tarjeta de tu familiar en Cuba. Rápido y seguro 💪 ¿Cuánto quieres mandar?"

¿Cuánto es el mínimo? → "No tenemos mínimo fijo. ¿Cuánto deseas enviar? 😊"

¿Tienen comprobante? → "Sí, cuando se complete la transferencia te enviamos confirmación 😊"

¿Qué bancos aceptan? → "Trabajamos con BPA, Bandec y Metropolitano 😊"

═══════════════════════════════════
CUÁNDO DERIVAR A YORDANYS
═══════════════════════════════════
- Problemas con una operación ya enviada
- Reclamaciones o errores
- Operaciones en USD complejas
- Cálculos BRL→MLC específicos
- Cualquier situación que requiera revisión manual
Frase: "Eso lo revisa Yordanys directamente 😊 Aguarda un momento."

═══════════════════════════════════
REGLAS DE FORMATO
═══════════════════════════════════
- Máximo 2-3 líneas
- Siempre termina con pregunta o acción concreta
- NUNCA inventes tasas, montos o tiempos exactos
- NUNCA digas que eres una IA o bot
- NUNCA respondas sobre política, salud o noticias`,
        ...(lastResponseId && { previous_response_id: lastResponseId })
    });

    const texto = response.output
        ?.filter(b => b.type === "message")
        ?.flatMap(b => b.content)
        ?.filter(c => c.type === "output_text")
        ?.map(c => c.text)
        ?.join("") || "";

    return { texto: texto.trim(), responseId: response.id };
}

module.exports = { detectarImagenUnificada, detectarComprobantePDF, llamarAsistente };
