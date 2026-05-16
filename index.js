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
  "depósito",
  "cuba"

];

/* =========================
   ENVIAR WHATSAPP
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

          "Client-Token":
            ZAPI_CLIENT_TOKEN,

          "Content-Type":
            "application/json"

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
   OPENAI AGENT
========================= */

async function responderIA(mensagem) {

  try {

    const response = await axios.post(

      "https://api.openai.com/v1/responses",

      {

        model: "gpt-4.1-mini",

        input: mensagem,

        instructions: `
Eres YordaBot.

Asistente de remesas por WhatsApp.

REGLAS:

- Responder corto.
- Máximo 2 líneas.
- Sonar humano.
- Sonar natural.
- No sonar como ChatGPT.
- No explicar demasiado.
- No usar listas.
- No repetir preguntas.
- No repetir saludos.
- Hablar en el idioma del cliente.

Responder solamente temas relacionados con:
remesas,
cambios,
PIX,
USD,
BRL,
CUP,
MLC,
recargas,
transferencias,
envíos.

Si el mensaje NO tiene intención comercial:
Responder EXACTAMENTE:
"No puedo ayudar con ese tema."
`

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

    return texto || "Dime 👍";

  } catch (error) {

    console.log(
      "ERRO OPENAI:"
    );

    console.log(
      error.response?.data ||
      error.message
    );

    return "Dime 👍";

  }

}

/* =========================
   WEBHOOK
========================= */

app.post("/webhook", async (req, res) => {

  try {

    const body = req.body;

    /* =========================
       IGNORAR EVENTOS
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

    /* =========================
       INTERVENCIÓN HUMANA
    ========================== */

    if (body.fromMe === true) {

      pausaHumana[phone] =
        Date.now() + (5 * 60 * 1000);

      console.log(
        "PAUSA HUMANA 5 MIN:",
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
        "BOT PAUSADO:",
        phone
      );

      return res.sendStatus(200);

    }

    console.log(
      "MENSAGEM:",
      texto
    );

    /* =========================
       DETECTAR INTENCIÓN
    ========================== */

    const comercial =
      gatilhos.some(g =>
        texto
          .toLowerCase()
          .includes(g)
      );

    if (!comercial) {

      console.log(
        "SEM INTENÇÃO COMERCIAL"
      );

      return res.sendStatus(200);

    }

    /* =========================
       OPENAI RESPONSE
    ========================== */

    const respostaIA =
      await responderIA(texto);

    /* =========================
       ENVIAR RESPOSTA
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
