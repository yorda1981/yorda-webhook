require("dotenv").config();

const OpenAI = require("openai");

const {
    enviarMensaje
} = require("./zapi");

const openai =
    new OpenAI({
        apiKey:
            process.env.OPENAI_API_KEY
    });

/**
 * Procesa mensajes entrantes
 */
async function procesarMensaje(
    phone,
    text
) {

    try {

        console.log(
            `🧠 Procesando mensaje para ${phone}: ${text}`
        );

        // =====================================
        // OPENAI
        // =====================================

        const completion =
            await openai.chat.completions.create({

                model: "gpt-4o-mini",

                messages: [

                    {
                        role: "system",
                        content:
`
Você é YordaBot.

REGRAS:

- Responda de forma humana.
- Nunca diga que está processando.
- Nunca diga "recebi sua mensagem".
- Seja curto e natural.
- Fale no idioma do cliente.
- Não fale do negócio se não perguntarem.
- Seja educado e vendedor.
- Respostas estilo WhatsApp real.
`
                    },

                    {
                        role: "user",
                        content: text
                    }
                ],

                temperature: 0.7,
                max_tokens: 300
            });

        // =====================================
        // RESPUESTA
        // =====================================

        const respuesta =
            completion.choices?.[0]
            ?.message
            ?.content
            ?.trim();

        if (!respuesta) {

            console.log(
                "❌ OpenAI devolvió vacío"
            );

            return "";
        }

        // =====================================
        // ENVIAR
        // =====================================

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
            "❌ Error en procesarMensaje:",
            error.message
        );

        return "";
    }
}

module.exports = {
    procesarMensaje
};
