const express = require("express");
const axios = require("axios");
const fs = require("fs");

const app = express();

app.use(express.json());

// =====================================
// JSONS
// =====================================

const taxas =
  JSON.parse(
    fs.readFileSync(
      "./taxas.json",
      "utf8"
    )
  );

const recargas =
  JSON.parse(
    fs.readFileSync(
      "./recargas.json",
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
Eres YordaBot.

Atiendes:
- remesas
- recargas
- CUP
- USD
- MLC
- PIX

REGLAS:

- Responder corto.
- Máximo 2 líneas.
- Nunca responder genérico.
- Nunca actuar como IA.
- Hablar natural.
- Si no tiene relación con remesas:
"No puedo ayudar con ese tema."

TASAS:

Menor de 100 reales:
${taxas.menos100} CUP

100 hasta 499:
${taxas.de100a499} CUP

500+:
${taxas.mais500} CUP

USD:
${taxas.tasa_USD} BRL

MLC:
${taxas.mlc} BRL

RECARGAS:

100 reales:
${recargas["100"].saldo} CUP

200 reales:
${recargas["200"].saldo} CUP

Saldo válido:
${recargas["100"].dias} días

Si preguntan:
- recarga
- saldo
- cup
- tasa
- cambio

responder directo.

Nunca responder largo.
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

          temperature: 0.2,

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

    const texto =
      resposta.data
      ?.choices?.[0]
      ?.message?.content
      ?.trim() || "";

    console.log(
      "RESPOSTA:",
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
// ENVIAR
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
      "ENVIADO"
    );

  } catch (erro) {

    console.log(
      "ERRO ZAPI"
    );

    console.log(
      erro.message
    );
  }
}

// =====================================
// WEBHOOK
// =====================================

app.post(
  "/webhook",
  async (req, res) => {

    try {

      if (
        req.body.isNewsletter
      ) {

        console.log(
          "NEWSLETTER IGNORADA"
        );

        return res.sendStatus(200);
      }

      if (
        req.body.isGroup
      ) {

        console.log(
          "GRUPO IGNORADO"
        );

        return res.sendStatus(200);
      }

      if (
        req.body.fromMe === true
      ) {

        console.log(
          "MENSAGEM BOT IGNORADA"
        );

        return res.sendStatus(200);
      }

      const messageId =
        req.body.messageId;

      if (
        mensagensProcessadas.has(
          messageId
        )
      ) {

        console.log(
          "DUPLICADA"
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
    "Servidor ONLINE 🚀"
  );
});
