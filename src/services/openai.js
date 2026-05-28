
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

    // CUBA
    "cuba",
    "cup",
    "mlc",
    "usd",
    "dolar",
    "dólar",
    "tarjeta",

    // CONSULTAS
    "cuanto",
    "cuánto",
    "cuanto recibe",
    "cuánto recibe",
    "cuanto llega",
    "cuánto llega",

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
Você é YordaBot.

REGRAS IMPORTANTES:

- Responda de forma humana e natural.
- Nunca diga:
  "Estou processando"
  "Recebi sua mensagem"
  "Aguarde"
- Respostas curtas estilo WhatsApp.
- Fale somente espanhol.
- Não fale do negócio se o cliente não perguntar.
- Seja educado, rápido e vendedor.
- Evite textos robóticos.
- Não use emojis exagerados.
- Não invente taxas.
- Não confirme pagamentos automaticamente.
- Não diga que é inteligência artificial.
- Se o cliente perguntar taxa ou câmbio:
  responda de forma clara e objetiva.
- Se o cliente quiser falar com Yordanys:
  diga que ele está ocupado no momento,
  mas entrará assim que possível.
- Seja especialista em:
  remesas,
  câmbio,
  transferências,
  PIX,
  recargas Cuba,
  CUP,
  MLC,
  USD.
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

                temperature: 0.4,

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

                "Hola 👋\n\nEn este momento estamos con alta demanda. Intenta nuevamente en unos minutos."
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
