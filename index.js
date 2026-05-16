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
  "transferir",
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
  "tarjeta",
  "cartão",
  "cartao",
  "habana",
  "efectivo",
  "entrega"

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

- Responder corto.
- Máximo 2 líneas.
- Sonar natural.
- No sonar como IA.
- No usar listas largas.
- No explicar demasiado.
- Hablar en idioma del cliente.

Operaciones:
- transferencia
- entrega
- recarga

No repetir preguntas.
No pedir datos ya informados.
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
      body.status !== "RECEIVED"

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

    const hora =
      new Date().getHours();

    /* =========================
       SILÊNCIO NOTURNO
    ========================== */

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
       GATILHOS
    ========================== */

    const comercial =
      gatilhos.some(g =>
        textoLimpo.includes(g)
      );

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

        operacion: null,
        moeda: null,
        monto: null,
        municipio: null,
        tarjeta: null,
        numero: null,
        aguardando: null,
        pixEnviado: false

      };

    }

    const estado =
      estadoCliente[phone];

    /* =========================
       DETECTAR OPERAÇÃO
    ========================== */

    if (

      textoLimpo.includes("transferencia") ||
      textoLimpo.includes("transferir") ||
      textoLimpo.includes("tarjeta")

    ) {

      estado.operacion =
        "transferencia";

    }

    if (

      textoLimpo.includes("entrega") ||
      textoLimpo.includes("habana") ||
      textoLimpo.includes("efectivo")

    ) {

      estado.operacion =
        "entrega";

    }

    if (

      textoLimpo.includes("recarga") ||
      textoLimpo.includes("etecsa")

    ) {

      estado.operacion =
        "recarga";

    }

    /* =========================
       DETECTAR MOEDA
    ========================== */

    if (

      textoLimpo.includes("real") ||
      textoLimpo.includes("reales") ||
      textoLimpo.includes("brl")

    ) {

      estado.moeda = "BRL";

    }

    if (

      textoLimpo.includes("usd") ||
      textoLimpo.includes("dolar") ||
      textoLimpo.includes("dólar")

    ) {

      estado.moeda = "USD";

    }

    /* =========================
       DETECTAR MONTO
    ========================== */

    const numero =
      texto.match(/\d+([.,]\d+)?/);

    if (numero) {

      estado.monto =
        numero[0];

    }

    /* =========================
       DETECTAR MUNICÍPIO
    ========================== */

    const municipios = [

      "habana",
      "centro habana",
      "habana vieja",
      "cerro",
      "boyeros",
      "arroyo naranjo",
      "marianao"

    ];

    municipios.forEach(m => {

      if (textoLimpo.includes(m)) {

        estado.municipio = m;

      }

    });

    /* =========================
       DETECTAR TARJETA
    ========================== */

    const tarjeta =
      texto.replace(/\D/g, "");

    if (

      tarjeta.length >= 16

    ) {

      estado.tarjeta =
        tarjeta;

    }

    /* =========================
       DETECTAR NÚMERO RECARGA
    ========================== */

    if (

      estado.operacion === "recarga"

    ) {

      const numeroRecarga =
        texto.replace(/\D/g, "");

      if (

        numeroRecarga.length >= 8

      ) {

        estado.numero =
          numeroRecarga;

      }

    }

    /* =========================
       FLUJO TRANSFERENCIA
    ========================== */

    if (

      estado.operacion === "transferencia"

    ) {

      if (!estado.monto) {

        estado.aguardando =
          "monto";

        await enviarMensaje(

          phone,

          "¿Cuántos reales deseas enviar?"

        );

        return res.sendStatus(200);

      }

      if (!estado.tarjeta) {

        estado.aguardando =
          "tarjeta";

        await enviarMensaje(

          phone,

          "Envíame la tarjeta 👌"

        );

        return res.sendStatus(200);

      }

      if (!estado.pixEnviado) {

        estado.pixEnviado = true;

        estado.aguardando =
          "comprovante";

        await enviarMensaje(

          phone,

          "8becaaf5-f296-4cbc-a115-46e3d23b042a"

        );

        await enviarMensaje(

          phone,

          "YORDANYS RAFAEL SOSA REYES\nNubank"

        );

        return res.sendStatus(200);

      }

    }

    /* =========================
       FLUJO ENTREGA
    ========================== */

    if (

      estado.operacion === "entrega"

    ) {

      if (!estado.monto) {

        estado.aguardando =
          "monto";

        await enviarMensaje(

          phone,

          "¿Cuántos reales deseas enviar?"

        );

        return res.sendStatus(200);

      }

      if (!estado.municipio) {

        estado.aguardando =
          "municipio";

        await enviarMensaje(

          phone,

          "¿Cuál municipio de La Habana?"

        );

        return res.sendStatus(200);

      }

      if (!estado.pixEnviado) {

        estado.pixEnviado = true;

        estado.aguardando =
          "comprovante";

        await enviarMensaje(

          phone,

          "8becaaf5-f296-4cbc-a115-46e3d23b042a"

        );

        await enviarMensaje(

          phone,

          "YORDANYS RAFAEL SOSA REYES\nNubank"

        );

        return res.sendStatus(200);

      }

    }

    /* =========================
       FLUJO RECARGA
    ========================== */

    if (

      estado.operacion === "recarga"

    ) {

      if (!estado.monto) {

        estado.aguardando =
          "monto";

        await enviarMensaje(

          phone,

          "¿De cuánto será la recarga?"

        );

        return res.sendStatus(200);

      }

      if (!estado.numero) {

        estado.aguardando =
          "numero";

        await enviarMensaje(

          phone,

          "Envíame el número 👌"

        );

        return res.sendStatus(200);

      }

      if (!estado.pixEnviado) {

        estado.pixEnviado = true;

        estado.aguardando =
          "comprovante";

        await enviarMensaje(

          phone,

          "8becaaf5-f296-4cbc-a115-46e3d23b042a"

        );

        await enviarMensaje(

          phone,

          "YORDANYS RAFAEL SOSA REYES\nNubank"

        );

        return res.sendStatus(200);

      }

    }

    /* =========================
       COMPROVANTE
    ========================== */

    if (

      estado.aguardando === "comprovante" &&

      (

        body.image ||
        textoLimpo.includes("pix") ||
        textoLimpo.includes("enviado") ||
        textoLimpo.includes("comprovante")

      )

    ) {

      await enviarMensaje(

        phone,

        "Comprovante recebido 👌"

      );

      await enviarMensaje(

        phone,

        "Sua operação será processada."

      );

      estadoCliente[phone] = {

        operacion: null,
        moeda: null,
        monto: null,
        municipio: null,
        tarjeta: null,
        numero: null,
        aguardando: null,
        pixEnviado: false

      };

      delete conversaAtiva[phone];

      return res.sendStatus(200);

    }

    /* =========================
       OPENAI FALLBACK
    ========================== */

    const contexto = JSON.stringify(
      estado,
      null,
      2
    );

    const respostaIA =
      await responderIA(
        texto,
        contexto
      );

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
