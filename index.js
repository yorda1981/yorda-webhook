const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

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
// DUPLICADAS
// =====================================

const mensagensProcessadas =
  new Set();

// =====================================
// PROMPT YORDA
// =====================================

const SYSTEM_PROMPT = `
Eres YordaBot.

Atiendes remesas y recargas.

Responde en el idioma del cliente.

Sé corto, natural y profesional.

Tasas:
Menor de 100 reales = 100 CUP
100-499 reales = 115 CUP
500+ reales = 118 CUP

USD = 5.60 BRL

Si preguntan montos:
calcula automáticamente.

Ejemplo:
300 reales = 34.500 CUP

No uses textos largos.
`;

// =====================================
// OPENAI
// =====================================

async function gerarResposta(
  mensagem
) {

  try {

    const resposta =
      await axios.post(

        "https://api.openai.com/v1/responses",

        {
          model:
            "gpt-4.1-mini",

          input: [

            {
              role: "system",
              content: SYSTEM_PROMPT
            },

            {
              role: "user",
              content: mensagem
            }
          ]
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
      "OPENAI RESPONSE:"
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
      ?.output?.[0]
      ?.content?.[0]
      ?.text;

    console.log(
      "TEXTO FINAL:",
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
// WHATSAPP
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
      "MENSAGEM ENVIADA"
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
// HOME
// =====================================

app.get("/", (req, res) => {

  res.send(
    "YordaBot ONLINE 🚀"
  );
});

// =====================================
// WEBHOOK
// =====================================

app.post(
  "/webhook",
  async (req, res) => {

    try {

      console.log("BODY:");
      console.log(req.body);

      // IGNORAR GRUPOS

      if (
        req.body.isGroup
      ) {

        return res.sendStatus(200);
      }

      // IGNORAR BOT

      if (
        req.body.fromMe
      ) {

        return res.sendStatus(200);
      }

      // IGNORAR NEWSLETTER

      if (
        req.body.isNewsletter
      ) {

        return res.sendStatus(200);
      }

      // DUPLICADAS

      const messageId =
        req.body.messageId;

      if (
        mensagensProcessadas.has(
          messageId
        )
      ) {

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

      // TEXTO

      const mensagem =
        req.body.text?.message;

      const numero =
        req.body.phone;

      console.log(
        "MENSAGEM:",
        mensagem
      );

      if (!mensagem) {

        return res.sendStatus(200);
      }

      // OPENAI

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

      // ENVIAR

      await enviarMensagem(
        numero,
        resposta
      );

      return res.sendStatus(200);

    } catch (erro) {

      console.log(
        "ERRO WEBHOOK:"
      );

      console.log(
        erro.message
      );

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
