
require("dotenv").config();

const OpenAI = require("openai");

const {
    enviarMensaje
} = require("./zapi");

const {
    calcularOperacion
} = require("./calculator");

// ==========================================
// OPENAI CLIENT
// ==========================================

const openai =
    new OpenAI({

        apiKey:
            process.env.OPENAI_API_KEY
    });

// ==========================================
// GATILHOS
// ==========================================

const gatilhos = [

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
    "cuanto",
    "cuánto",
    "cup",
    "usd",
    "mlc",
    "pix",
    "remesa",
    "transferencia",
    "enviar",
    "mandar",
    "tarjeta",
    "recarga",
    "saldo",
    "internet",
    "nauta",
    "yordanys",
    "asesor",
    "humano"
];

// ==========================================
// NORMALIZAR
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
            "Procesando mensaje para:",
            phone,
            text
        );

        if (!text) {
            return "";
        }

        const texto =
            normalizarTexto(text);

        // ==========================================
        // ACTIVAR IA SOLO EN MENSAJES COMERCIALES
        // ==========================================

        const activarIA =
            gatilhos.some(

                g =>

                    texto.includes(
                        normalizarTexto(g)
                    )
            );

        if (!activarIA) {

            console.log(
                "Mensaje ignorado"
            );

            return "";
        }

        // ==========================================
        // DETECTAR MONTO + REAL
        // ==========================================

        const numeroDetectado =
            texto.match(/\d+/);

        if (

            numeroDetectado &&

            (
                texto.includes("real") ||
                texto.includes("reales") ||
                texto.includes("brl")
            )

        ) {

            const valor =
                Number(
                    numeroDetectado[0]
                );

            const resultado =
                calcularOperacion({

                    tipo: "brl_cup",

                    valor
                });

            if (resultado) {

                const respuesta =
`Hoy estamos trabajando a ${resultado.tasa} CUP por real 🇨🇺

Con ${valor} reales llegan ${resultado.cup.toLocaleString()} CUP 👍`;

                await enviarMensaje(
                    phone,
                    respuesta
                );

                console.log(
                    `Mensaje enviado a ${phone}`
                );

                return respuesta;
            }
        }

        // ==========================================
        // SYSTEM PROMPT
        // ==========================================

        const systemPrompt =
`
Eres YordaBot.

REGLAS:

- Responder SIEMPRE en español.
- Hablar como vendedor humano.
- Respuestas cortas.
- Sonar natural.
- No parecer IA.
- No usar respuestas técnicas.
- No decir:
  "Estoy procesando"
  "Aguarde"
  "transacción"

- Hablar como atención real de WhatsApp.

IMPORTANTE:

- Si preguntan por cambio:
  responder corto y vendedor.

- Si quieren hablar con Yordanys:
  decir que ahora está ocupado,
  pero entra al chat apenas pueda.

- Nunca inventar tasas.

- Nunca inventar cálculos.

- No escribir textos largos.
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
        // RESPUESTA IA
        // ==========================================

        const respuesta =
            completion
                ?.choices?.[0]
                ?.message?.content
                ?.trim();

        if (!respuesta) {

            console.log(
                "OpenAI vacío"
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
            `Mensaje enviado a ${phone}`
        );

        return String(respuesta);

    } catch (error) {

        console.error(
            "Error en procesarMensaje:"
        );

        console.error(
            error.message
        );

        try {

            await enviarMensaje(

                phone,

                "Hola 👋\n\nAhora mismo estamos con alta demanda. Escríbeme nuevamente en unos minutos."
            );

        } catch (e) {

            console.error(
                "Error enviando fallback"
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
