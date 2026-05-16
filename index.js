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
   PAUSA HUMANA
========================= */

const pausaHumana = {};

/* =========================
   GATILHOS NEGOCIO
========================= */

const gatilhos = [

  "remesa",
  "remesas",
  "envio",
  "enviar",
  "transferencia",
  "transferência",
  "cambio",
  "câmbio",
  "tasa",
  "taxa",
  "tasas",
  "taxas",
  "real",
  "reales",
  "brl",
  "cup",
  "usd",
  "dolar",
  "dólar",
  "pix",
  "mlc",
  "recarga",
  "saldo",
  "etecsa",
  "dinero",
  "dinheiro",
  "deposito",
  "depósito"

];

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
          ". Responde corto, natural y comercial sobre remesas, cambios o recargas."

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
    ========================== */

    if (

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
       PAUSA HUMANA
    ========================== */

    if (body.fromMe === true) {

      pausaHumana[phone] =
        Date.now() + (10 * 60 * 1000);

      console.log(
        "PAUSA HUMANA ATIVADA:",
        phone
      );

      return res.sendStatus(200);

    }

    /* =========================
       VERIFICAR PAUSA
    ========================== */

    if (

      pausaHumana[phone] &&
      Date.now() < pausaHumana[phone]

    ) {

      console.log(
        "BOT EM PAUSA:",
        phone
      );

      return res.sendStatus(200);

    }

    /* =========================
       DETECTAR INTERES
    ========================== */

    const comercial =
      gatilhos.some(g =>
        texto
          .toLowerCase()
          .includes(g)
      );

    /* =========================
       IGNORAR SIN GATILHO
    ========================== */

    if (!comercial) {

      console.log(
        "IGNORADO SEM GATILHO"
      );

      return res.sendStatus(200);

    }

    /* =========================
       OPENAI RESPONSE
    ========================== */

    const respostaIA =
      await responderIA(texto);

    /* =========================
       ENVIAR WHATSAPP
    ========================== */

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
