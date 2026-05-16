const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 8080;

/* =========================
   VARIABLES
========================= */

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY;

const ZAPI_INSTANCE =
  process.env.ZAPI_INSTANCE;

const ZAPI_TOKEN =
  process.env.ZAPI_TOKEN;

const ZAPI_CLIENT_TOKEN =
  process.env.ZAPI_CLIENT_TOKEN;

/* =========================
   PAUSA HUMANA
========================= */

const pausaHumana = {};

/* =========================
   GATILHOS NEGÓCIO
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
   SAUDAÇÕES
========================= */

const saudacoes = [

  "hola",
  "oi",
  "ola",
  "olá",
  "buenas",
  "bom dia",
  "boa tarde",
  "boa noite",
  "buen dia",
  "buenos dias",
  "buenas tardes",
  "buenas noches"

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
   OPENAI
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

Asistente humano de remesas por WhatsApp.

REGLAS:

- Responder corto.
- Máximo 2 líneas.
- Sonar natural.
- Sonar humano.
- No sonar como ChatGPT.
- No usar listas.
- No explicar demasiado.
- No repetir preguntas.
- Hablar en el idioma del cliente.

Responder solamente sobre:
remesas,
cambios,
USD,
BRL,
CUP,
MLC,
PIX,
recargas,
transferencias,
envíos.
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
       HORARIO
    ========================== */

    const hora =
      new Date().getHours();

    /* =========================
       SILENCIO NOCTURNO
    ========================== */

    if (hora >= 22 || hora < 6) {

      console.log(
        "HORÁRIO DE DESCANSO"
      );

      return res.sendStatus(200);

    }

    /* =========================
       INTERVENÇÃO HUMANA
    ========================== */

    if (body.fromMe === true) {

      pausaHumana[phone] =
        Date.now() + (5 * 60 * 1000);

      console.log(
        "PAUSA HUMANA:",
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
       SAUDAÇÃO
    ========================== */

    const saudacao =
      saudacoes.some(s =>
        texto
          .toLowerCase()
          .includes(s)
      );

    if (saudacao) {

      let saludo = "";

      if (hora >= 6 && hora < 12) {

        saludo =
          "Buen día 👋 ¿Cómo puedo ayudarte hoy?";

      } else if (hora >= 12 && hora < 18) {

        saludo =
          "Buenas tardes 👋 ¿Cómo puedo ayudarte hoy?";

      } else {

        saludo =
          "Buenas noches 👋 ¿Cómo puedo ayudarte hoy?";

      }

      await enviarMensaje(
        phone,
        saludo
      );

      return res.sendStatus(200);

    }

    /* =========================
       GATILHOS NEGÓCIO
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
