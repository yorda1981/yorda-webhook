require("dotenv").config();

const OpenAI = require("openai");

const {
    enviarMensaje
} = require("./zapi");

// ==========================================
// OPENAI
// ==========================================

const openai =
    new OpenAI({

        apiKey:
            process.env.OPENAI_API_KEY
    });

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
- Fale somente no idioma do cliente.
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

                temperature: 0.7,

                max_tokens: 300
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

        if (
            !respuesta
        ) {

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

        // ==========================================
        // RETORNAR TEXTO
        // ==========================================

        return String(respuesta);

    } catch (error) {

        console.error(
            "❌ Error en procesarMensaje:"
        );

        console.error(
            error.message
        );

        return "";
    }
}

// ==========================================
// EXPORT
// ==========================================

module.exports = {
    procesarMensaje
};
