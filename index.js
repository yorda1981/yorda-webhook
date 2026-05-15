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

    console.log("BODY:");
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
    // IGNORAR MENSAGENS DO PRÓPRIO BOT
    // ==================================

    if (req.body.fromMe) {

      console.log(
        "MENSAGEM DO PRÓPRIO BOT IGNORADA"
      );

      return res.sendStatus(200);
    }

    // ==================================
    // NÚMERO
    // ==================================

    const numero =
      req.body.phone;

    // ==================================
    // MENSAGEM
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

        "https://api.openai.com/v1/chat/completions",

        {
          model: "gpt-4o-mini",

          messages: [

            {
              role: "system",

              content:
                "Você é um atendente útil, amigável e objetivo."
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
              `Bearer ${process.env.OPENAI_API_KEY}`,

            "Content-Type":
              "application/json"
          }
        }
      );

    // ==================================
    // PEGAR RESPOSTA
    // ==================================

    const resposta =
      respostaOpenAI.data
      ?.choices?.[0]
      ?.message?.content || "";

    console.log(
      "RESPOSTA:",
      resposta
    );

    if (!resposta) {

      console.log(
        "GPT SEM TEXTO"
      );

      return res.sendStatus(200);
    }

    // ==================================
    // ENVIAR WHATSAPP
    // ==================================

    await axios.post(

      process.env.ZAPI_URL,

      {
        phone: numero,

        message: resposta
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
      "ERRO:"
    );

    console.log(
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
