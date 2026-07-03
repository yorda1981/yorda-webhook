"use strict";

const OpenAI   = require("openai");
const pdfParse = require("pdf-parse");
const env      = require("../config/env");
const { parseGPT, getPIXKey, getPIXAliases } = require("./shared");

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ─────────────────────────────────────────
// RETRY — reintento automático ante fallos de OpenAI
// ─────────────────────────────────────────
async function conReintento(fn, intentos = 3, delayMs = 1500) {
    for (let i = 0; i < intentos; i++) {
        try {
            return await fn();
        } catch (e) {
            const esPrematureClose = e.message?.includes("Premature close") ||
                                     e.message?.includes("fetch failed") ||
                                     e.message?.includes("ECONNRESET") ||
                                     e.message?.includes("timeout");
            if (esPrematureClose && i < intentos - 1) {
                console.warn(`⚠️ OpenAI fallo (intento ${i+1}/${intentos}): ${e.message} — reintentando...`);
                await new Promise(r => setTimeout(r, delayMs * (i + 1)));
                continue;
            }
            throw e;
        }
    }
}

// ─────────────────────────────────────────
// PROMPT OCR — IMAGEN
// ─────────────────────────────────────────

function promptImagen() {
    const aliases = getPIXAliases().join(", ");
    const key     = getPIXKey();
    return `Analiza esta imagen con máxima atención. Puede ser una tarjeta bancaria cubana, un comprobante PIX brasileño, u otra cosa. Responde SOLO en JSON válido, sin texto adicional.

FORMATOS POSIBLES:

TARJETA: {"tipo":"tarjeta","tarjeta":"SOLO16DIGITOS","titular":"NOMBRE COMPLETO","banco":"bandec|bpa|metropolitano|otro","valida":true}
COMPROBANTE PIX: {"tipo":"comprovante_pix","valor":200,"fecha":"DD/MM/AAAA","hora":"HH:MM","banco":"banco origen","destinatario":"nombre","destino_correcto":true,"valido":true}
OTRO: {"tipo":"otro"}

═══════════════════════════
REGLAS PARA TARJETA CUBANA
═══════════════════════════
IDENTIFICACIÓN:
- Las tarjetas cubanas tienen 16 dígitos numéricos en grupos de 4: XXXX XXXX XXXX XXXX
- Bancos cubanos conocidos:
  * BPA = Banco Popular de Ahorro (logo azul/verde, texto "bpa" o "banco popular de ahorro")
  * Bandec = Banco de Crédito y Comercio (logo rojo/naranja)
  * Metropolitano = Banco Metropolitano (logo azul)
- El titular aparece en la parte inferior en mayúsculas
- Suelen tener "CUP", "MLC" o "USD" indicando el tipo de moneda
- Fecha de vencimiento formato MM/AA en la parte inferior

EXTRACCIÓN:
- Extrae SOLO los 16 dígitos, sin espacios ni guiones → string de exactamente 16 caracteres
- Si la imagen está girada, borrosa, tiene reflejo o es un reenvío → intenta igualmente
- Si ves al menos 12 dígitos claramente → extráelos y pon valida:false
- Si el número tiene espacios entre grupos (ej: "9205 1299 7635 2031") → únelos: "9205129976352031"
- NO confundas con números de teléfono (empiezan con 55 + 11 dígitos en Brasil)
- NO confundas con DNI, RG, CPF u otros documentos

FALSOS POSITIVOS A EVITAR:
- Capturas de pantalla de conversaciones de WhatsApp → tipo:"otro"
- Fotos de billetes o efectivo → tipo:"otro"
- Tarjetas de crédito brasileñas (Visa, Master, Elo) → tipo:"otro" (no son cubanas)
- Documentos de identidad → tipo:"otro"

═══════════════════════════
REGLAS PARA COMPROBANTE PIX
═══════════════════════════
IDENTIFICACIÓN — MÚLTIPLES FORMATOS:
El comprobante PIX puede aparecer en varios formatos:

FORMATO 1 — Comprobante estándar:
- Texto: "Pix enviado", "Transferência realizada", "Comprovante", "Pix efetuado"
- Tiene valor en R$, fecha, hora, destinatario

FORMATO 2 — Detalle de transacción bancaria (Banco do Brasil, Nubank, etc.):
- Tiene campos como: "Chave Pix", "Pagador", "Instituição", "Conta", "Agência"
- Tiene ID de transação (formato: E + números largos)
- Puede NO tener el valor visible pero tiene la chave PIX
- Este formato es igualmente válido como comprobante

FORMATO 3 — Recibo de app bancario:
- Puede tener "Comprovante de transferência", "Dados da transação"
- Campos: "Valor", "Data do débito", "Número de controle"

EXTRACCIÓN:
- valor: número puro sin símbolo (200.50, no "R$200,50") — si no está visible, null
- fecha: DD/MM/AAAA — buscar en "Data do débito", "Data", fecha de la transacción
- hora: HH:MM — buscar en la fecha o campo de hora
- banco: banco del PAGADOR (quien envió) — campo "Instituição" del pagador
- destinatario: buscar en campo "Recebedor", "Destinatário", "Nome" del recibidor — si no está, null
- destino_correcto: true si aparece la chave PIX: ${key || "(no configurada)"}
  O si el destinatario coincide con: ${aliases}
  O si la "Instituição" del recibidor contiene "NU PAGAMENTOS" o "NUBANK"
- valido: true si el documento parece auténtico

IMPORTANTE: Si ves "Chave Pix: ${key || ""}" en la imagen → destino_correcto: true automáticamente
- datos faltantes o ilegibles → null

SEÑALES DE COMPROBANTE FALSO:
- Fuentes inconsistentes o diferentes en el mismo documento
- Valores editados visiblemente
- Fechas imposibles o incoherentes
- Si sospechas que es falso → valido:false

Sin texto extra fuera del JSON.`;
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
// OCR — Imagen
// ─────────────────────────────────────────

async function detectarImagenUnificada(imageUrl) {
    try {
        const r = await conReintento(() => openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: [
                { type: "text",      text: promptImagen() },
                { type: "image_url", image_url: { url: imageUrl, detail: "high" } }
            ]}],
            max_tokens: 300
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
