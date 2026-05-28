
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
    "clasica",
    "clásica",
    "prepago",
    "yordanys",
    "asesor",
    "humano"
];

// ==========================================
// NORMALIZAR
// ==========================================

function normalizarTexto(texto) {

    return String(texto || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

// ==========================================
// FORMATEAR
// ==========================================

function formatearNumero(numero) {

    return Number(numero)
        .toLocaleString("es-ES");
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

        if (!text) {
            return "";
        }

        const texto =
            normalizarTexto(text);

        // ==========================================
        // ACTIVAR SOLO MENSAJES COMERCIALES
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
                "🚫 Mensaje ignorado"
            );

            return "";
        }

        // ==========================================
        // DETECTAR MONTO
        // ==========================================

        const numeroDetectado =
            texto.match(/\d+/);

        const valor =
            numeroDetectado
                ? Number(numeroDetectado[0])
                : null;

        // ==========================================
        // BRL → CUP
        // ==========================================

        if (

            valor &&

            (
                texto.includes("real") ||
                texto.includes("reales") ||
                texto.includes("brl")
            )

        ) {

            const resultado =
                calcularOperacion({

                    tipo: "brl_cup",

                    valor
                });

            if (resultado) {

                const respuesta =
`Hoy estamos trabajando a ${resultado.tasa} CUP por real 🇨🇺

Con ${valor} reales llegan ${formatearNumero(resultado.cup)} CUP 👍`;

                await enviarMensaje(
                    phone,
                    respuesta
                );

                return respuesta;
            }
        }

        // ==========================================
        // USD CLÁSICA
        // ==========================================

        if (

            valor &&

            texto.includes("usd") &&

            (
                texto.includes("clasica") ||
                texto.includes("clásica")
            )

        ) {

            const resultado =
                calcularOperacion({

                    tipo: "usd_clasica",

                    valor
                });

            if (resultado) {

                const respuesta =
`La USD clásica hoy está en ${resultado.tasa} CUP 🇨🇺

Con ${valor} USD clásica llegan ${formatearNumero(resultado.cup)} CUP 👍`;

                await enviarMensaje(
                    phone,
                    respuesta
                );

                return respuesta;
            }
        }

        // ==========================================
        // USD PREPAGO
        // ==========================================

        if (

            valor &&

            texto.includes("usd") &&

            texto.includes("prepago")

        ) {

            const resultado =
                calcularOperacion({

                    tipo: "usd_prepago",

                    valor
                });

            if (resultado) {

                const respuesta =
`La USD prepago hoy está en ${resultado.tasa} CUP 🇨🇺

Con ${valor} USD prepago llegan ${formatearNumero(resultado.cup)} CUP 👍`;

                await enviarMensaje(
                    phone,
                    respuesta
                );

                return respuesta;
            }
        }

        // ==========================================
        // CONSULTA GENERAL CAMBIO
        // ==========================================

        if (

            texto.includes("cambio") ||

            texto.includes("tasa") ||

            texto.includes("cotizacion") ||

            texto.includes("cotización")

        ) {

            const respuesta =
"Hoy estamos trabajando con muy buena tasa 👍\n\n¿Deseas calcular reales, USD clásica o USD prepago?";

            await enviarMensaje(
                phone,
                respuesta
            );

            return respuesta;
        }

        // ==========================================
        // HABLAR CON YORDANYS
        // ==========================================

        if (

            texto.includes("yordanys") ||

            texto.includes("humano") ||

            texto.includes("asesor")

        ) {

            const respuesta =
"Yordanys ahora mismo está ocupado 👌\n\nApenas pueda entra al chat.";

            await enviarMensaje(
                phone,
                respuesta
            );

            return respuesta;
        }

        // ==========================================
        // OPENAI
        // ==========================================

        const systemPrompt =
`
Eres YordaBot.

REGLAS:

- Responder siempre en español.
- Sonar humano.
- Respuestas cortas estilo WhatsApp.
- Hablar como vendedor real.
- No parecer IA.
- No inventar tasas.
- No inventar cálculos.
- No usar textos largos.
- No usar lenguaje técnico.
- No decir:
  "procesando"
  "transacción"
  "aguarde"

- Si no sabes una tasa:
  pedir el monto.
`;

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

        const respuesta =
            completion
                ?.choices?.[0]
                ?.message?.content
                ?.trim();

        if (!respuesta) {

            console.log(
                "❌ OpenAI vacío"
            );

            return "";
        }

        // ==========================================
        // ENVIAR
        // ==========================================

        await enviarMensaje(
            phone,
            respuesta
        );

        console.log(
            `✅ Mensaje enviado a ${phone}`
        );

        return respuesta;

    } catch (error) {

        console.error(
            "❌ Error en procesarMensaje:"
        );

        console.error(
            error.message
        );

        try {

            await enviarMensaje(

                phone,

                "Hola 👋\n\nAhora mismo estamos con muchas solicitudes. Escríbeme nuevamente en unos minutos."
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
