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
// PROMPT GPT
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
      "RESPOSTA GPT:",
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
      // IGNORAR BOT
      // =================================

      if (
        req.body.fromMe === true
      ) {

        console.log(
          "MENSAGEM BOT IGNORADA"
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
      // DADOS
      // =================================

      const mensagem =
        req.body.text?.message || "";

      const numero =
        req.body.phone;

      const msg =
        mensagem.toLowerCase();

      console.log(
        "MENSAGEM:",
        mensagem
      );

      if (!mensagem) {

        return res.sendStatus(200);
      }

      // =================================
      // PIX
      // =================================

      if (
        msg.includes("pix")
      ) {

        await enviarMensagem(
          numero,

`PIX OFICIAL:

8becaaf5-f296-4cbc-a115-46e3d23b042a

YORDANYS RAFAEL SOSA REYES
Nubank`
        );

        return res.sendStatus(200);
      }

      // =================================
      // TASAS
      // =================================

      if (
        msg.includes("tasa") ||
        msg.includes("tasas")
      ) {

        await enviarMensagem(
          numero,

`Tasas hoy:

<100 BRL → ${taxas.menos100} CUP
100-499 BRL → ${taxas.de100a499} CUP
500+ BRL → ${taxas.mais500} CUP

Las tasas pueden variar.`
        );

        return res.sendStatus(200);
      }

      // =================================
      // RECARGA
      // =================================

      if (
        msg.includes("recarga")
      ) {

        await enviarMensagem(
          numero,

`Recarga disponible:

100 reales →
${recargas["100"].saldo} CUP

Saldo válido:
${recargas["100"].dias} días`
        );

        return res.sendStatus(200);
      }

      // =================================
      // CALCULAR REALES
      // =================================

      const numeroDetectado =
        parseInt(
          msg.match(/\d+/)?.[0]
        );

      if (
        numeroDetectado &&
        (
          msg.includes("real") ||
          msg.includes("reales")
        )
      ) {

        let tasa = 0;

        if (
          numeroDetectado < 100
        ) {

          tasa =
            taxas.menos100;

        } else if (
          numeroDetectado <= 499
        ) {

          tasa =
            taxas.de100a499;

        } else {

          tasa =
            taxas.mais500;
        }

        const total =
          numeroDetectado * taxa;

        await enviarMensagem(
          numero,

`${numeroDetectado} reales son ${total} CUP.`
        );

        return res.sendStatus(200);
      }

      // =================================
      // IGNORAR SALUDOS
      // =================================

      const saludos = [

        "hola",
        "oi",
        "ola",
        "buenas",
        "bom dia",
        "boa tarde",
        "boa noite"
      ];

      if (
        saludos.includes(msg)
      ) {

        return res.sendStatus(200);
      }

      // =================================
      // GPT
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
      // ENVIAR GPT
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
    `Servidor ONLINE ${PORT}`
  );
});
