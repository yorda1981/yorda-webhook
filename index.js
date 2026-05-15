const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

// ======================================
// CONFIG
// ======================================

const pausados = {};

// ======================================
// HOME
// ======================================

app.get("/", (req, res) => {

  res.send("BOT ONLINE 🚀");
});

// ======================================
// WEBHOOK
// ======================================

app.post("/webhook", async (req, res) => {

  try {

    console.log(req.body);

    // ==================================
    // IGNORAR GRUPOS
    // ==================================

    if (req.body.isGroup) {

      console.log(
        "GRUPO IGNORADO"
      );

      return res.sendStatus(200);
    }

    // ==================================
    // IGNORAR NEWSLETTER
    // ==================================

    if (req.body.isNewsletter) {

      console.log(
        "NEWSLETTER IGNORADA"
      );

      return res.sendStatus(200);
    }

    // ==================================
    // PEGAR NÚMERO
    // ==================================

    const numero =
      req.body.phone;

    // ==================================
    // PEGAR MENSAGEM
    // ==================================

    const mensagem =
      req.body.text?.message || "";

    console.log(
      "MENSAGEM:",
      mensagem
    );

    if (!numero) {

      return res.sendStatus(200);
    }

    // ==================================
    // PAUSA MANUAL
    // ==================================

    if (
      req.body.fromMe &&
      !req.body.fromApi
    ) {

      pausados[numero] =
        Date.now();

      console.log(
        "BOT PAUSADO:",
        numero
      );

      return res.sendStatus(200);
    }

    // ==================================
    // VERIFICAR PAUSA
    // ==================================

    if (pausados[numero]) {

      const tempoPassado =
        Date.now() -
        pausados[numero];

      // 30 minutos

      if (
        tempoPassado <
        30 * 60 * 1000
      ) {

        console.log(
          "CONVERSA PAUSADA"
        );

        return res.sendStatus(200);
      }

      delete pausados[numero];

      console.log(
        "BOT REATIVADO"
      );
    }

    // ==================================
    // OPENAI
    // ==================================

    const respostaOpenAI =
      await axios.post(

        "https://api.openai.com/v1/responses",

        {
          model:
            "gpt-4o-mini",

          input:
            `Cliente enviou: ${mensagem}`
        },

        {
          headers: {

            Authorization:
              `Bearer ${process.env.OPENAI_API_KEY}`,

            "Content-Type":
              "application/json"
          }
        }
      );

    // ==================================
    // LER RESPOSTA
    // ==================================

    let resposta = "";

    if (
      respostaOpenAI.data.output_text
    ) {

      resposta =
        respostaOpenAI.data
        .output_text;

    } else {

      resposta =
        respostaOpenAI.data
        ?.output?.[0]
        ?.content?.[0]
        ?.text || "";
    }

    console.log(
      "RESPOSTA:",
      resposta
    );

    if (!resposta) {

      console.log(
        "SEM RESPOSTA GPT"
      );

      return res.sendStatus(200);
    }

    // ==================================
    // ENVIAR WHATSAPP
    // ==================================

    await axios.post(

      process.env.ZAPI_URL,

      {
        phone:
          numero,

        message:
          resposta
      },

      {
        headers: {

          "Client-Token":
            process.env.ZAPI_CLIENT_TOKEN,

          "Content-Type":
            "application/json"
        }
      }
    );

    console.log(
      "RESPOSTA ENVIADA"
    );

    return res.sendStatus(200);

  } catch (error) {

    console.log(
      "ERRO:",
      error.response?.data ||
      error.message
    );

    return res.sendStatus(500);
  }
});

// ======================================
// START
// ======================================

const PORT =
  process.env.PORT || 8080;

app.listen(PORT, () => {

  console.log(
    `Servidor online na porta ${PORT}`
  );
});
