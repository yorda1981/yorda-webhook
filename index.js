const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 8080;

/* =========================
   VARIABLES
========================= */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;

const ZAPI_TOKEN = process.env.ZAPI_TOKEN;

const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

/* =========================
   ENVIAR MENSAJE
========================= */

async function enviarMensaje(phone, texto) {

  try {

    const url =
      "https://api.z-api.io/instances/" +
      ZAPI_INSTANCE +
      "/token/" +
      ZAPI_TOKEN +
      "/send-text";

    const response = await axios.post(

      url,

      {
        phone: phone,
        message: texto
      },

      {
        headers: {
          "Client-Token": ZAPI_CLIENT_TOKEN,
          "Content-Type": "application/json"
        }
      }

    );

    console.log(
      "ENVIADO:",
      response.data
    );

  } catch (error) {

    console.log(
      "ERRO ZAPI:"
    );

    console.log(
      error.response?.data ||
      error.message
    );

  }

}

/* =========================
   OPENAI
========================= */

async function responderIA(mensagem) {

  try {

    const response = await axios.post(

      "https://api.openai.com/v1/responses",

      {

        model: "gpt-4.1-mini",

        input:
          "Cliente escreveu: " +
          mensagem +
          ". Responde corto y natural sobre remesas, cambios o recargas."

      },

      {

        headers: {

          Authorization:
            "Bearer " + OPENAI_API_KEY,

          "Content-Type":
            "application/json"

        }

      }

    );

    const texto =
      response.data.output?.[0]?.content?.[0]?.text;

    return texto || "Hola 👋";

  } catch (error) {

    console.log(
      "ERRO OPENAI:"
    );

    console.log(
      error.response?.data ||
      error.message
    );

    return "Hola 👋";

  }

}

/* =========================
   WEBHOOK
========================= */

app.post("/webhook", async (req, res) => {

  try {

    const body = req.body;

    /* =========================
       IGNORAR
    ========================= */

    if (

      body.fromMe === true ||
      body.isGroup === true ||
      body.isNewsletter === true ||
      body.isEdit === true ||
      body.fromApi === true ||
      body.status !== "RECEIVED" ||
      body.sticker ||
      body.image ||
      body.video ||
      body.audio ||
      body.document

    ) {

      return res.sendStatus(200);

    }

    /* =========================
       LOG SOLO VALIDOS
    ========================= */

    console.log(
      "BODY:",
      JSON.stringify(body, null, 2)
    );

    const texto =
      body?.text?.message || "";

    const phone =
      body.phone;

    if (!texto) {

      return res.sendStatus(200);

    }

    console.log(
      "MENSAGEM:",
      texto
    );

    /* =========================
       OPENAI RESPONSE
    ========================= */

    const respostaIA =
      await responderIA(texto);

    /* =========================
       ENVIAR WHATSAPP
    ========================= */

    await enviarMensaje(
      phone,
      respostaIA
    );

    return res.sendStatus(200);

  } catch (error) {

    console.log(
      "ERRO GERAL:"
    );

    console.log(
      error.response?.data ||
      error.message
    );

    return res.sendStatus(500);

  }

});

/* =========================
   ONLINE
========================= */

app.get("/", (req, res) => {

  res.send(
    "YordaBot ONLINE"
  );

});

/* =========================
   START
========================= */

app.listen(PORT, () => {

  console.log(
    "Servidor ONLINE na porta " + PORT
  );

});
