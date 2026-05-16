const express = require("express");
const axios = require("axios");
const fs = require("fs");

const app = express();

app.use(express.json());

// =====================================
// TAXAS JSON
// =====================================

const taxas =
  JSON.parse(
    fs.readFileSync(
      "./taxas.json",
      "utf8"
    )
  );

// =====================================
// CONFIG
// =====================================

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY;

const ZAPI_URL =
  process.env.ZAPI_URL;

const ZAPI_CLIENT_TOKEN =
  process.env.ZAPI_CLIENT_TOKEN;

// =====================================
// CONTROLE
// =====================================

const mensagensProcessadas =
  new Set();

// =====================================
// PROMPT
// =====================================

const SYSTEM_PROMPT = `
Eres YordaBot, el agente virtual oficial del servicio de remesas y recargas gestionado por Yordanys.

Tu función es atender clientes por WhatsApp.

REGLAS IMPORTANTES:

- Responde siempre corto.
- Máximo 2 líneas.
- Nunca responder genérico.
- Nunca actuar como IA.
- Hablar como vendedor real de WhatsApp.
- Responder en español o portugués.
- Si el mensaje no tiene relación con remesas:
responder:
"No puedo ayudar con ese tema."

TASAS ACTUALES:

Menor de 100 reales:
${taxas.menos100} CUP

100 hasta 499 reales:
${taxas.de100a499} CUP

500+ reales:
${taxas.mais500} CUP

USD:
1 USD = ${taxas.tasa_USD} BRL

MLC:
${taxas.mlc} BRL

Si preguntan:
- tasa
- cambio
- cup
- reales
- cuanto llega

calcular automáticamente.

Ejemplos:

100 reales → ${
  100 * taxas.de100a499
} CUP

500 reales → ${
  500 * taxas.mais500
} CUP

Nunca responder largo.
Nunca dar explicaciones innecesarias.

Las tasas pueden variar según el momento del pago.
`;

// =====================================
// HOME
// =====================================

app.get("/", (req, res) => {

  res.send(
    "YordaBot ONLINE 🚀"
  );
});

// =====================================
// OPENAI
// =====================================

async function gerarResposta(
  mensagem
) {

  try {

    const resposta =
      await axios.post(

        "https://api.openai.com/v1/chat/completions",

        {
          model:
            "gpt-4o-mini",

          messages: [

            {
              role: "system",
              content:
                SYSTEM_PROMPT
            },

            {
              role: "user",
              content:
                mensagem
            }
          ],

          temperature: 0.3,

          max_tokens: 80
        },

        {
          headers: {

            Authorization:
              `Bearer ${OPENAI_API_KEY}`,

            "Content-Type":
              "application/json"
          }
        }
      );

    console.log(
      "OPENAI COMPLETA:"
    );

    console.log(
      JSON.stringify(
        resposta.data,
        null,
        2
      )
    );

    const texto =
      resposta.data
      ?.choices?.[0]
      ?.message?.content
      ?.trim() || "";

    console.log(
      "RESPOSTA FINAL:",
      texto
    );

    return texto;

  } catch (erro) {

    console.log(
      "ERRO OPENAI:"
    );

    if (
      erro.response?.data
    ) {

      console.log(
        JSON.stringify(
          erro.response.data,
          null,
          2
        )
      );

    } else {

      console.log(
        erro.message
      );
    }

    return null;
  }
}

// =====================================
// ENVIAR WHATSAPP
// =====================================

async function enviarMensagem(
  numero,
  mensagem
) {

  try {

    await axios.post(

      ZAPI_URL,

      {
        phone: numero,
        message: mensagem
      },

      {
        headers: {

          "Client-Token":
            ZAPI_CLIENT_TOKEN,

          "Content-Type":
            "application/json"
        }
      }
    );

    console.log(
      "ENVIADO COM SUCESSO"
    );

  } catch (erro) {

    console.log(
      "ERRO ZAPI:"
    );

    if (
      erro.response?.data
    ) {

      console.log(
        JSON.stringify(
          erro.response.data,
          null,
          2
        )
      );

    } else {

      console.log(
        erro.message
      );
    }
  }
}

// =====================================
// WEBHOOK
// =====================================

app.post(
  "/webhook",
  async (req, res) => {

    try {

      console.log("BODY:");
      console.log(req.body);

      // =================================
      // IGNORAR NEWSLETTER
      // =================================

      if (
        req.body.isNewsletter
      ) {

        console.log(
          "NEWSLETTER IGNORADA"
        );

        return res.sendStatus(200);
      }

      // =================================
      // IGNORAR GRUPOS
      // =================================

      if (
        req.body.isGroup
      ) {

        console.log(
          "GRUPO IGNORADO"
        );

        return res.sendStatus(200);
      }

      // =================================
      // IGNORAR MENSAGENS DO BOT
      // =================================

      if (
        req.body.fromMe === true
      ) {

        console.log(
          "MENSAGEM DO BOT IGNORADA"
        );

        return res.sendStatus(200);
      }

      // =================================
      // EVITAR DUPLICADAS
      // =================================

      const messageId =
        req.body.messageId;

      if (
        mensagensProcessadas.has(
          messageId
        )
      ) {

        console.log(
          "MENSAGEM DUPLICADA"
        );

        return res.sendStatus(200);
      }

      mensagensProcessadas.add(
        messageId
      );

      setTimeout(() => {

        mensagensProcessadas.delete(
          messageId
        );

      }, 600000);

      // =================================
      // TEXTO
      // =================================

      const mensagem =
        req.body.text?.message || "";

      const numero =
        req.body.phone;

      console.log(
        "MENSAGEM:",
        mensagem
      );

      if (!mensagem) {

        return res.sendStatus(200);
      }

      // =================================
      // OPENAI
      // =================================

      const resposta =
        await gerarResposta(
          mensagem
        );

      if (!resposta) {

        console.log(
          "SEM RESPOSTA"
        );

        return res.sendStatus(200);
      }

      // =================================
      // ENVIAR
      // =================================

      await enviarMensagem(
        numero,
        resposta
      );

      return res.sendStatus(200);

    } catch (erro) {

      console.log(
        "ERRO WEBHOOK:"
      );

      if (
        erro.response?.data
      ) {

        console.log(
          JSON.stringify(
            erro.response.data,
            null,
            2
          )
        );

      } else {

        console.log(
          erro.message
        );
      }

      return res.sendStatus(500);
    }
  }
);

// =====================================
// START
// =====================================

const PORT =
  process.env.PORT || 8080;

app.listen(PORT, () => {

  console.log(
    `Servidor ONLINE na porta ${PORT}`
  );
});
