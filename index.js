```javascript
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
        "PAUSADO:",
        numero
      );

      return res.sendStatus(200);
    }

    // ==================================
    // VERIFICAR PAUSA
    // ==================================

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

    console.log(
      "MENSAGEM:",
      mensagem
    );

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

    const resposta =
      respostaOpenAI.data
      .output_text;

    console.log(
      "RESPOSTA:",
      resposta
    );

    if (!resposta) {

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
      "ENVIADO"
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

const PORT =
  process.env.PORT || 8080;

app.listen(PORT, () => {

  console.log(
    "Servidor online"
  );
});
```
