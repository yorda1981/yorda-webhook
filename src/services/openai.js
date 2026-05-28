
require("dotenv").config();

const OpenAI = require("openai");

const {
    enviarMensaje
} = require("./zapi");

// ==========================================
// OPENAI CLIENT
// ==========================================

const openai =
    new OpenAI({

        apiKey:
            process.env.OPENAI_API_KEY
    });

// ==========================================
// GATILHOS COMERCIAIS
// ==========================================

const gatilhos = [

    // CAMBIO
    "real",
    "reales",
    "brl",
    "cambio",
    "cambiar",
    "taxa",
    "tasa",
    "cotizacion",
    "cotización",
    "precio",
    "valor",
    "cuanto esta",
    "como esta el real",
    "a como esta",

    // DINERO
    "enviar",
    "mandar",
    "transferencia",
    "transferir",
    "remesa",
    "remesas",
    "dinero",
    "deposito",
    "depósito",
    "pix",
    "tarjeta",

    // CUBA
    "cuba",
    "cup",
    "mlc",
    "usd",
    "dolar",
    "dólar",

    // CONSULTAS
    "cuanto",
    "cuánto",
    "cuanto recibe",
    "cuánto recibe",
    "cuanto llega",
    "cuánto llega",
    "calcular",
    "calculo",
    "calcula",

    // RECARGAS
    "recarga",
    "saldo",
    "internet",
    "nauta",

    // HUMANO
    "yordanys",
    "asesor",
    "atendente",
    "humano"
];

// ==========================================
// NORMALIZAR TEXTO
// ==========================================

function normalizarTexto(texto) {

    return String(texto)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

// ==========================================
// PROCESAR MENSAJE
// ==========================================

async function procesarMensaje(
    phone,
    text
) {

    try {

        console.log(
            `🧠 Procesando mensaje para ${phone}: ${text}`
        );

        // ==========================================
        // VALIDAR TEXTO
        // ==========================================

        if (!text) {

            return "";
        }

        // ==========================================
        // INTENT ENGINE
        // ==========================================

        const texto =
            normalizarTexto(text);

        const activarIA =
            gatilhos.some(

                g =>

                    texto.includes(
                        normalizarTexto(g)
                    )
            );

        // ==========================================
        // IGNORAR MENSAJES SIN INTENCIÓN
        // ==========================================

        if (!activarIA) {

            console.log(
                "😴 Mensaje ignorado"
            );

            return "";
        }

        // ==========================================
        // SYSTEM PROMPT
        // ==========================================

        const systemPrompt =
`
Eres YordaBot.

REGLAS IMPORTANTES:

- Responder SIEMPRE en español.
- Hablar como vendedor humano de WhatsApp.
- Respuestas cortas y naturales.
- Nunca responder como IA.
- Nunca usar respuestas técnicas.
- Nunca decir:
  "Estoy procesando"
  "Recibí tu mensaje"
  "Aguarde"
  "transacción"
  "cotización específica"

- No usar textos largos.
- No usar emojis exagerados.
- Sonar rápido, humano y confiable.
- Hablar natural como atención real.

IMPORTANTE:

- Solo hablar del negocio si el cliente pregunta algo relacionado.
- Si el cliente solo saluda:
  responder saludo corto.

- Si preguntan por real, cambio o tasa:
  responder directo.

EJEMPLOS:

Cliente:
"como esta el real"

Respuesta:
"Hoy estamos trabajando a 124 🇨🇺"

Cliente:
"tasa"

Respuesta:
"124 CUP por real 🇨🇺"

Cliente:
"100 reales"

Respuesta:
"Con 100 reales recibe 12.400 CUP 🇨🇺"

Cliente:
"quiero enviar"

Respuesta:
"Dime cuánto deseas enviar 👍"

Cliente:
"quiero hablar con yordanys"

Respuesta:
"Ahora mismo está ocupado, pero en cuanto pueda entra al chat 👍"

ESPECIALISTA EN:

- Remesas Cuba
- Cambio BRL CUP
- PIX
- Transferencias
- Recargas Cuba
- CUP
- MLC
- USD

IMPORTANTE:

- Responder como humano REAL.
- No parecer chatbot.
`;

        // ==========================================
        // OPENAI REQUEST
        // ==========================================

        const completion =
            await openai.chat.completions.create({

                model: "gpt-4o-mini",

                messages: [

                    {
                        role: "system",
                        content: systemPrompt
                    },

                    {
                        role: "user",
                        content: text
                    }
                ],

                temperature: 0.5,

                max_tokens: 120
            });

        // ==========================================
        // RESPUESTA
        // ==========================================

        const respuesta =
            completion
                ?.choices?.[0]
                ?.message?.content
                ?.trim();

        // ==========================================
        // VALIDAR RESPUESTA
        // ==========================================

        if (!respuesta) {

            console.log(
                "❌ OpenAI devolvió vacío"
            );

            return "";
        }

        // ==========================================
        // ENVIAR MENSAJE
        // ==========================================

        await enviarMensaje(
            phone,
            respuesta
        );

        console.log(
            `✅ Mensaje enviado a ${phone}`
        );

        return String(respuesta);

    } catch (error) {

        console.error(
            "❌ Error en procesarMensaje:"
        );

        console.error(
            error.message
        );

        // ==========================================
        // FALLBACK
        // ==========================================

        try {

            await enviarMensaje(

                phone,

                "Hola 👋\n\nEn este momento estamos con alta demanda. Escríbeme nuevamente en unos minutos."
            );

        } catch (e) {

            console.error(
                "❌ Error enviando fallback"
            );
        }

        return "";
    }
}

// ==========================================
// EXPORT
// ==========================================

module.exports = {
    procesarMensaje
};
