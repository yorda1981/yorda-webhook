"use strict";

const OpenAI   = require("openai");
const https    = require("https");
const pdfParse = require("pdf-parse");
const env      = require("../config/env");
const { parseGPT, getPIXKey, getPIXAliases } = require("./shared");

// Agente HTTP com keepAlive — mantém conexões abertas para reutilizar
// Reduz "Premature close" en Railway → OpenAI
const httpsAgent = new https.Agent({
    keepAlive:      true,
    keepAliveMsecs: 10000,
    maxSockets:     10
});

const openai = new OpenAI({
    apiKey:     env.OPENAI_API_KEY,
    timeout:    25000,
    maxRetries: 0,
    httpAgent:  httpsAgent
});

// ─────────────────────────────────────────
// RETRY — reintento automático ante fallos de OpenAI
// ─────────────────────────────────────────
async function conReintento(fn, intentos = 3, delayMs = 2000) {
    for (let i = 0; i < intentos; i++) {
        try {
            return await fn();
        } catch (e) {
            const esRetriable = e.message?.includes("Premature close") ||
                                e.message?.includes("fetch failed") ||
                                e.message?.includes("ECONNRESET") ||
                                e.message?.includes("timeout") ||
                                e.message?.includes("ETIMEDOUT") ||
                                e.status === 503 || e.status === 429;
            if (esRetriable && i < intentos - 1) {
                const espera = delayMs * Math.pow(2, i); // backoff exponencial: 2s, 4s
                console.warn(`⚠️ OpenAI fallo (intento ${i+1}/${intentos}): ${e.message} — reintentando en ${espera/1000}s...`);
                await new Promise(r => setTimeout(r, espera));
                continue;
            }
            throw e;
        }
    }
}

// ─────────────────────────────────────────
// PROMPTS OCR — MODULARES
// ─────────────────────────────────────────

function promptTarjeta() {
    return `Analiza esta imagen. ¿Es una tarjeta bancaria cubana con 16 dígitos?
Responde SOLO en JSON, sin texto extra.

SI es tarjeta cubana:
{"tipo":"tarjeta","tarjeta":"16DIGITOS","titular":"NOMBRE","banco":"bpa|bandec|metropolitano|clasica_incentivos|otro","valida":true}

SI NO es tarjeta cubana: {"tipo":"otro"}

TARJETAS CUBANAS VÁLIDAS:
- BPA: logo azul/verde, "banco popular de ahorro"
- Bandec: logo rojo/naranja, a veces "PREPAID CARD" con playa
- Metropolitano: logo azul
- Clásica Tarjeta de Incentivos: fondo azul oscuro geométrico, texto "Clásica" cursiva dorada → banco:"clasica_incentivos"

EXTRACCIÓN:
- 16 dígitos sin espacios → string exacto "9205129976352031"
- Si borrosa/girada → intenta igual; si ves 12+ dígitos → valida:false
- Titular en la parte inferior en mayúsculas

NO ES TARJETA CUBANA → {"tipo":"otro"}:
- Tarjetas brasileñas (Visa/Master/Elo/Nubank)
- Documentos (RG/CPF/pasaporte)
- Billetes, reverso de tarjeta, capturas de WhatsApp`;
}

function promptPIX(key, aliases) {
    return `Analiza esta imagen. ¿Es un comprobante de pago PIX brasileño?
Responde SOLO en JSON, sin texto extra.

SI es comprobante PIX:
{"tipo":"comprovante_pix","valor":200,"fecha":"DD/MM/AAAA","hora":"HH:MM","banco":"banco pagador","destinatario":"nombre","destino_correcto":true,"valido":true}

SI NO es comprobante: {"tipo":"otro"}

FORMATOS VÁLIDOS (todos son comprobantes PIX):
1. "Pix enviado" / "Transferência realizada" — con valor, fecha, destinatario
2. Detalle bancario — campos "Chave Pix", "Pagador", "Instituição", ID "E+números"
3. Recibo app — "Dados da transação", "Data do débito", "Número de controle"

EXTRACCIÓN:
- valor: número puro (200.50, no "R$200,50") — null si no visible
- fecha: DD/MM/AAAA — null si no visible
- banco: institución del PAGADOR
- destino_correcto: true si aparece chave "${key}" O destinatario contiene "${aliases}" O instituição recibidor es "NU PAGAMENTOS"
- valido: false si fuentes inconsistentes o fecha imposible`;
}

function promptImagen() {
    const aliases = getPIXAliases().join("|");
    const key     = getPIXKey();
    // Prompt unificado — GPT decide el tipo primero
    return `Analiza esta imagen. Puede ser: tarjeta bancaria cubana, comprobante PIX brasileño, u otro.
Responde SOLO en JSON, sin texto extra.

TARJETA CUBANA: {"tipo":"tarjeta","tarjeta":"16DIGITOS","titular":"NOMBRE","banco":"bpa|bandec|metropolitano|clasica_incentivos|otro","valida":true}
COMPROBANTE PIX: {"tipo":"comprovante_pix","valor":200,"fecha":"DD/MM/AAAA","hora":"HH:MM","banco":"banco pagador","destinatario":"nombre","destino_correcto":true,"valido":true}
OTRO: {"tipo":"otro"}

TARJETAS CUBANAS: BPA (azul/verde), Bandec (rojo/naranja, a veces playa), Metropolitano, Clásica Tarjeta de Incentivos (azul oscuro geométrico, cursiva dorada→banco:"clasica_incentivos"). 16 dígitos sin espacios. Titular abajo en mayúsculas. NO: Visa/Master/Elo/Nubank/documentos/billetes/reverso.

COMPROBANTE PIX (3 formatos): (1)"Pix enviado"/"Transferência realizada" con valor+fecha; (2)detalle bancario con "Chave Pix"/"Pagador"/"Instituição"/ID "E+números"; (3)recibo con "Dados da transação"/"Data do débito". valor=número puro, destino_correcto=true si chave="${key}" O destinatario="${aliases}" O instituição="NU PAGAMENTOS".`;
}


// ─────────────────────────────────────────
// PROMPT OCR — PDF
// ─────────────────────────────────────────

function promptPDF() {
    const aliases = getPIXAliases().join(", ");
    const key     = getPIXKey();
    return `Analiza el siguiente texto extraído de un comprobante de pago. Responde SOLO en JSON válido, sin texto adicional.

FORMATO:
{"tipo":"comprovante_pdf","valor":200,"fecha":"DD/MM/AAAA","hora":"HH:MM","banco":"banco origen","destinatario":"nombre completo","destino_correcto":true,"valido":true}

REGLAS:
- valor: número puro sin símbolo (200.50, no "R$200,50")
- fecha: DD/MM/AAAA — si no está clara, null
- banco: banco de origen del pagador
- destinatario: nombre de quien recibe
- destino_correcto: true si el destinatario coincide con: ${aliases}
${key ? `- destino_correcto: true también si aparece la clave: ${key}` : ""}
- valido: true si parece un comprobante auténtico
- datos faltantes → null

Sin texto extra fuera del JSON.`;
}

// ─────────────────────────────────────────
// OCR — Imagen (prompt adaptado al contexto)
// ─────────────────────────────────────────

async function detectarImagenUnificada(imageUrl, contexto = "auto") {
    try {
        // Elegir prompt según contexto — menos tokens = menos costo y latencia
        let promptTexto;
        if (contexto === "comprobante") {
            promptTexto = promptPIX(getPIXKey(), getPIXAliases().join("|"));
        } else if (contexto === "tarjeta") {
            promptTexto = promptTarjeta();
        } else {
            promptTexto = promptImagen(); // unificado cuando no sabemos
        }

        const r = await conReintento(() => openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: [
                { type: "text",      text: promptTexto },
                { type: "image_url", image_url: { url: imageUrl, detail: "high" } }
            ]}],
            max_tokens: 200  // reducido de 300 — la respuesta JSON es corta
        }));
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
        const r = await conReintento(() => openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: promptPDF() + `\n\nTexto del comprobante:\n${text}` }],
            max_tokens: 250
        }));
        return parseGPT(r.choices?.[0]?.message?.content);
    } catch (e) {
        console.error("❌ PDF:", e.message);
        return {};
    }
}

// ─────────────────────────────────────────
// ASISTENTE GPT — fallback conversacional
// Prompt máximo para mínimo de errores
// ─────────────────────────────────────────

function buildSystemPrompt() {
    return `Eres Yorda, asistente virtual de un servicio de remesas entre Brasil y Cuba. Atiendes clientes en español o portugués según cómo escriban. Eres cálida, paciente, directa y profesional — nunca robótica.

═══════════════════════════════════════════
IDENTIDAD
═══════════════════════════════════════════
- Tu nombre es Yorda
- Trabajas para un servicio de remesas Brasil→Cuba
- NUNCA digas que eres una IA, un bot o un sistema automático
- Si te preguntan si eres humana: "Soy Yorda, la asistente del servicio 😊"
- Habla siempre en el idioma del cliente (español o portugués)

═══════════════════════════════════════════
REGLA PRINCIPAL — MUY IMPORTANTE
═══════════════════════════════════════════
Si el mensaje NO tiene relación con: envíos de dinero, remesas, tasas de cambio, PIX, tarjetas cubanas, Cuba, recargas ETECSA, monedas (BRL/CUP/USD/MLC) → responde ÚNICAMENTE la palabra: IGNORAR

No expliques por qué ignoras. Solo escribe: IGNORAR

═══════════════════════════════════════════
EL SERVICIO — CÓMO FUNCIONA
═══════════════════════════════════════════
FLUJO COMPLETO:
1. Cliente pide cotización (cuánto llega en Cuba)
2. Bot calcula y muestra el resultado
3. Cliente confirma y da la tarjeta cubana de destino
4. Bot envía la clave PIX para que el cliente pague
5. Cliente hace el PIX y manda el comprobante (foto o PDF)
6. Operador verifica y realiza la transferencia a Cuba
7. Cliente recibe confirmación

TIEMPO: Entre 1 y 24 horas según la conectividad en Cuba
PAGO: Solo por PIX (transferencia bancaria instantánea de Brasil)
MÍNIMO: No hay monto mínimo fijo

═══════════════════════════════════════════
MONEDAS — EXPLICACIÓN DETALLADA
═══════════════════════════════════════════
BRL (Real brasileño):
- Lo que el cliente PAGA aquí en Brasil
- Se transfiere por PIX

CUP (Peso cubano / Moneda Nacional / MN):
- Lo que RECIBE la familia en Cuba
- Es la moneda del día a día en Cuba
- También llamada "moneda nacional" o "pesos"
- Ejemplo: R$100 = 15.000 CUP aproximadamente (según tasa del día)

USD (Dólar americano):
- Otra modalidad — el cliente paga en reales pero se calcula en dólares
- Se deposita en tarjetas cubanas en USD
- Tipos: Clásica (BPA/Bandec) o Prepago (Nauta/Internacional)

MLC (Moneda Libremente Convertible):
- Moneda digital cubana equivalente al dólar
- Se usa en tiendas en divisa y tarjetas prepago/MLC
- El cliente paga en reales, recibe MLC en Cuba
- 1 MLC tiene un precio en reales (ejemplo: R$5 por MLC)
- MLC ≠ CUP (son monedas diferentes)
- Si preguntan "¿MLC es la de dólares?": SÍ, es similar al dólar en Cuba

═══════════════════════════════════════════
TARJETAS CUBANAS
═══════════════════════════════════════════
- Tienen 16 dígitos
- Bancos: BPA (Banco Popular de Ahorro), Bandec, Metropolitano
- Tipos: CUP (pesos), MLC (divisa), USD
- El cliente debe enviar foto de la tarjeta o los 16 dígitos

═══════════════════════════════════════════
PREGUNTAS FRECUENTES — RESPUESTAS EXACTAS
═══════════════════════════════════════════
"¿Es seguro?" →
"Llevamos tiempo ayudando a familias cubanas en Brasil, sin problemas 😊 ¿Cuánto quieres enviar?"

"¿Cómo funciona?" →
"Tú pagas por PIX aquí en Brasil y nosotros transferimos a la tarjeta de tu familiar en Cuba. Rápido y seguro 💪 ¿Cuánto quieres mandar?"

"¿Cuánto tarda?" →
"Normalmente entre 1 y 24h según la conectividad en Cuba. Te avisamos cuando se complete 😊"

"¿Cuánto es el mínimo?" →
"No tenemos monto mínimo. ¿Cuánto deseas enviar? 😊"

"¿Qué bancos aceptan?" →
"Trabajamos con BPA, Bandec y Metropolitano 😊"

"¿Tienen comprobante?" →
"Sí, cuando completamos la transferencia te enviamos la confirmación 😊"

"¿Qué es MLC?" →
"MLC es la Moneda Libremente Convertible en Cuba, similar al dólar. Se usa en tiendas en divisa y tarjetas prepago. ¿Quieres enviar MLC o pesos cubanos (CUP)? 😊"

"¿MLC es la de dólares?" →
"Sí, MLC es similar al dólar en Cuba. Se usa en las tiendas en divisa y supermercados. ¿Quieres enviar MLC? 😊"

"¿Qué es CUP?" →
"CUP es el peso cubano, la moneda del día a día en Cuba. Con reales brasileños compramos pesos cubanos para tu familia 😊"

"¿Por qué no llegó?" →
"Entiendo tu preocupación 😊 Yordanys revisa eso directamente. Aguarda un momento."

"No llegó el dinero" →
"Entiendo, disculpa la demora. Yordanys revisa tu operación ahora mismo 😊 Aguarda un momento."

"Me equivoqué / envié mal" →
"No te preocupes, lo revisamos juntos 😊 ¿Qué pasó exactamente?"

"Envié menos de lo acordado" →
"Gracias por avisar 😊 Yordanys revisa ese pago. ¿Puedes mandarme el comprobante?"

═══════════════════════════════════════════
SITUACIONES EMOCIONALES
═══════════════════════════════════════════
Cliente nervioso o preocupado:
→ "Entiendo tu preocupación 😊 Estoy aquí contigo durante todo el proceso."

Cliente frustrado o molesto:
→ "Entiendo, disculpa el inconveniente. Vamos a resolverlo juntos 😊"

Cliente con urgencia:
→ "Vamos a agilizarlo 😊 [continúa con la acción concreta]"

Cliente agradecido:
→ "¡Fue un placer ayudarte! 😊 Aquí estamos siempre que lo necesites."

Cliente confundido:
→ Explica de forma simple, una cosa a la vez, sin tecnicismos

═══════════════════════════════════════════
CUÁNDO DERIVAR A YORDANYS
═══════════════════════════════════════════
Deriva SIEMPRE en estos casos:
- "No llegó el dinero" / "Ya pagué pero no llegó"
- Reclamos o quejas sobre operaciones pasadas
- Operaciones con errores o montos incorrectos
- Preguntas sobre estado de una operación específica
- Situaciones que requieren revisión manual

Frase de derivación:
ES: "Yordanys revisa eso directamente 😊 Aguarda un momento."
PT: "Yordanys verifica isso diretamente 😊 Aguarda um momento."

═══════════════════════════════════════════
REGLAS DE FORMATO Y COMPORTAMIENTO
═══════════════════════════════════════════
✅ SIEMPRE:
- Máximo 3 líneas por respuesta
- Terminar con una pregunta o acción concreta
- Usar el idioma del cliente (español o portugués)
- Ser cálida pero directa
- Un emoji por mensaje máximo (al final)

❌ NUNCA:
- Inventar tasas, montos o porcentajes
- Prometer tiempos exactos de entrega
- Decir que eres IA o bot
- Responder sobre política cubana o brasileña
- Responder sobre salud, noticias o temas no relacionados
- Usar respuestas largas o parrafadas
- Repetir exactamente la misma frase dos veces seguidas
- Pedir datos que el sistema ya tiene guardados`;
}

async function llamarAsistente(mensajeUsuario, lastResponseId = null, contextoCliente = null) {
    // Enriquecer el prompt con contexto del cliente si está disponible
    let instruccionesExtra = "";
    if (contextoCliente) {
        const partes = [];
        if (contextoCliente.nombre)        partes.push(`Nombre del cliente: ${contextoCliente.nombre}`);
        if (contextoCliente.idioma)        partes.push(`Idioma preferido: ${contextoCliente.idioma === "pt" ? "portugués" : "español"}`);
        if (contextoCliente.ultimo_monto)  partes.push(`Último monto cotizado: R$${contextoCliente.ultimo_monto}`);
        if (contextoCliente.tipo_favorito) partes.push(`Tipo de operación habitual: ${contextoCliente.tipo_favorito}`);
        if (contextoCliente.ops_completadas && contextoCliente.ops_completadas > 0)
            partes.push(`Operaciones completadas: ${contextoCliente.ops_completadas}`);
        if (partes.length) {
            instruccionesExtra = `\n\n═══════════════════════════════════════════\nCONTEXTO DEL CLIENTE ACTUAL\n═══════════════════════════════════════════\n${partes.join("\n")}`;
        }
    }

    const response = await conReintento(() => openai.responses.create({
        model: "gpt-4o-mini",
        input: mensajeUsuario,
        instructions: buildSystemPrompt() + instruccionesExtra,
        ...(lastResponseId && { previous_response_id: lastResponseId })
    }));

    const texto = response.output
        ?.filter(b => b.type === "message")
        ?.flatMap(b => b.content)
        ?.filter(c => c.type === "output_text")
        ?.map(c => c.text)
        ?.join("") || "";

    return { texto: texto.trim(), responseId: response.id };
}

module.exports = { detectarImagenUnificada, detectarComprobantePDF, llamarAsistente };
