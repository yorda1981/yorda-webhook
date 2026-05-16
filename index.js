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
   MEMÓRIAS
========================= */

const pausaHumana = {};

const conversaAtiva = {};

const estadoCliente = {};

/* =========================
   GATILHOS
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
  "pasarte dinero",
  "mandar dinero",
  "hacer un envío",
  "hacer un envio"

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

async function responderIA(mensagem, contexto = "") {

  try {

    const response = await axios.post(

      "https://api.openai.com/v1/responses",

      {

        model: "gpt-4.1-mini",

        input: `
CONTEXTO:
${contexto}

CLIENTE:
${mensagem}
`,

        instructions: `
Eres YordaBot.

Asistente humano de remesas.

REGLAS:

- Máximo 2 líneas.
- Hablar natural.
- No sonar como IA.
- No usar listas.
- No repetir preguntas.
- No explicar demasiado.
- Hablar en idioma del cliente.

Si el cliente habla de envío:
guiar la conversación paso a paso.

Si ya sabes:
- moneda
- monto
- destino

NO volver a preguntar eso.

Si cliente menciona:
real/reales/brl
interpretar BRL.

Si cliente menciona:
usd/dólar
interpretar USD.

Si cliente pide PIX:
entregar PIX directamente.

Si cliente pide hablar con Yordanys:
responder:
"Claro 👌 Yordanys continuará tu atención en breve."
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
       HORÁRIO
    ========================== */

    const hora =
      new Date().getHours();

    if (hora >= 22 || hora < 6) {

      console.log(
        "HORÁRIO DE DESCANSO"
      );

      return res.sendStatus(200);

    }

    /* =========================
       PAUSA HUMANA
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
       TEXTO LIMPO
    ========================== */

    const textoLimpo =
      texto
        .toLowerCase()
        .replace(/[^\w\s]/gi, " ");

    /* =========================
       GATILHO
    ========================== */

    const comercial =
      gatilhos.some(g =>
        textoLimpo.includes(g)
      );

    /* =========================
       CONVERSA
    ========================== */

    if (comercial) {

      conversaAtiva[phone] =
        Date.now() + (15 * 60 * 1000);

    }

    const conversaEmAndamento =

      conversaAtiva[phone] &&
      Date.now() < conversaAtiva[phone];

    /* =========================
       SAUDAÇÃO
    ========================== */

    const saudacao =
      saudacoes.some(s =>
        textoLimpo.includes(s)
      );

    if (

      saudacao &&
      !comercial &&
      !conversaEmAndamento

    ) {

      let saludo = "";

      if (hora >= 6 && hora < 12) {

        saludo =
          "Buen día 👋 ¿Cómo puedo ayudarte hoy?";

      } else if (hora >= 12 && hora < 20) {

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
       IGNORAR
    ========================== */

    if (

      !comercial &&
      !conversaEmAndamento

    ) {

      console.log(
        "SEM INTENÇÃO COMERCIAL"
      );

      return res.sendStatus(200);

    }

    /* =========================
       ESTADO CLIENTE
    ========================== */

    if (!estadoCliente[phone]) {

      estadoCliente[phone] = {

        moeda: null,
        destino: null,
        monto: null,
        tipo: null

      };

    }

    /* =========================
       DETECTAR MOEDA
    ========================== */

    if (

      textoLimpo.includes("real") ||
      textoLimpo.includes("reales") ||
      textoLimpo.includes("brl")

    ) {

      estadoCliente[phone].moeda =
        "BRL";

    }

    if (

      textoLimpo.includes("usd") ||
      textoLimpo.includes("dolar") ||
      textoLimpo.includes("dólar")

    ) {

      estadoCliente[phone].moeda =
        "USD";

    }

    /* =========================
       DETECTAR TIPO
    ========================== */

    if (

      textoLimpo.includes("envio") ||
      textoLimpo.includes("remesa") ||
      textoLimpo.includes("transferencia")

    ) {

      estadoCliente[phone].tipo =
        "remesa";

    }

    if (

      textoLimpo.includes("recarga")

    ) {

      estadoCliente[phone].tipo =
        "recarga";

    }

    /* =========================
       DETECTAR MONTO
    ========================== */

    const numero =
      texto.match(/\d+/);

    if (numero) {

      estadoCliente[phone].monto =
        numero[0];

    }

    /* =========================
       CONTEXTO
    ========================== */

    const contexto = `
TIPO:
${estadoCliente[phone].tipo || "desconocido"}

MONEDA:
${estadoCliente[phone].moeda || "desconocida"}

MONTO:
${estadoCliente[phone].monto || "desconocido"}
`;

    /* =========================
       OPENAI
    ========================== */

    const respostaIA =
      await responderIA(
        texto,
        contexto
      );

    /* =========================
       ENVIAR
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
