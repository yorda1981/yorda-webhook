const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const pausados = {};

app.get("/", (req, res) => {
  res.send("BOT ONLINE");
});

app.post("/webhook", async (req, res) => {

  try {

    console.log("BODY:");
    console.log(req.body);

    if (req.body.isGroup) {
      return res.sendStatus(200);
    }

    if (req.body.isNewsletter) {
      return res.sendStatus(200);
    }

    const numero =
      req.body.phone;

    const mensagem =
      req.body.text?.message || "";

    console.log(
      "MENSAGEM:",
      mensagem
    );

    if (!numero) {
      return res.sendStatus(200);
    }

    // =========================
    // PAUSA MANUAL
    // =========================

    if (
      req.body.fromMe &&
      !req.body.fromApi
    ) {

      pausados[numero] =
        Date.now();

      console.log(
        "BOT PAUSADO"
      );

      return res.sendStatus(200);
    }

    // =========================
    // VERIFICAR PAUSA
    // =========================

    if (pausados[numero]) {

      const tempo =
        Date.now() -
        pausados[numero];

      if (
        tempo <
        30 * 60 * 1000
      ) {

        console.log(
          "CONVERSA PAUSADA"
        );

        return res.sendStatus(200);
      }

      delete pausados[numero];
    }

    // =========================
    // OPENAI
    // =========================

    const respostaOpenAI =
      await axios.post(

        "https://api.openai.com/v1/chat/completions",

        {
          model: "gpt-4o-mini",

          messages: [
            {
              role: "system",
              content:
                "Você é um atendente útil."
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

    console.log(
      "OPENAI COMPLETA:"
    );

    console.log(
      JSON.stringify(
        respostaOpenAI.data,
        null,
        2
      )
    );

    const resposta =
      respostaOpenAI.data
      ?.choices?.[0]
      ?.message?.content || "";

    console.log(
      "RESPOSTA FINAL:",
      resposta
    );

    if (!resposta) {

      console.log(
        "GPT SEM TEXTO"
      );

      return res.sendStatus(200);
    }

    // =========================
    // ENVIAR WHATSAPP
    // =========================

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
      "ENVIADO COM SUCESSO"
    );

    return res.sendStatus(200);

  } catch (error) {

    console.log("ERRO:");

    console.log(
      error.response?.data ||
      error.message
    );

    return res.sendStatus(500);
  }
});

const PORT =
  process.env.PORT || 8080;

app.listen(PORT, () => {

  console.log(
    `Servidor online ${PORT}`
  );
});
