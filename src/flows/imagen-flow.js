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
        const { text } = await pdfParse(buf, { version: "v2.0.550" });
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
        instructions: `Eres Yorda, asistente de remesas Brasil→Cuba. Cálida, cercana y directa. Sin formalismos.

REGLA PRINCIPAL: Si el mensaje no tiene relación con envíos, remesas, tasas, PIX, tarjetas, Cuba, dinero → responde ÚNICAMENTE con la palabra: IGNORAR

No escribas "Silencio total" ni nada más. Solo: IGNORAR

CÓMO RESPONDES:
- Máximo 2 líneas. Sin parrafadas.
- Siempre termina con una pregunta o acción concreta.
- Si preguntan si es seguro: "Llevamos tiempo ayudando a familias cubanas en Brasil, sin problemas 😊 ¿Cuánto quieres enviar?"
- Si preguntan cómo funciona: "Tú pagas por PIX y nosotros transferimos a la tarjeta en Cuba. Rápido y seguro 💪 ¿Cuánto quieres mandar?"
- Si preguntan cuánto tarda: "Normalmente entre 1 y 24h según la conectividad en Cuba 😊"
- Recargas ETECSA: "Eso lo maneja Yordanys directamente 😊 Aguarda un momento. 👌"

NUNCA: Inventes tasas ni montos. Prometas horarios exactos. Saludes. Respondas sobre política, salud o noticias.`,
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
