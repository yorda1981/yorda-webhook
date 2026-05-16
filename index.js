```javascript id="v4m2rx"
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

    console.log("URL:", url);

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
   WEBHOOK
========================= */

app.post("/webhook", async (req, res) => {

  try {

    const body = req.body;

    console.log(
      "BODY:",
      JSON.stringify(body, null, 2)
    );

    /* =========================
       IGNORAR
    ========================= */

    if (
      body.fromMe === true ||
      body.isGroup === true ||
      body.isNewsletter === true
    ) {

      return res.sendStatus(200);

    }

    const phone = body.phone;

    const texto =
      body?.text?.message || "";

    if (!texto) {

      return res.sendStatus(200);

    }

    console.log(
      "MENSAGEM:",
      texto
    );

    /* =========================
       RESPUESTA SIMPLE
    ========================= */

    await enviarMensaje(
      phone,
      "Hola 👋 ¿Cómo puedo ayudarte?"
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

  res.send("YordaBot ONLINE");

});

app.listen(PORT, () => {

  console.log(
    "Servidor ONLINE na porta " + PORT
  );

});
```
