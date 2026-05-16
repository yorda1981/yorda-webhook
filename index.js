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
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;

    const response = await axios.post(

      url,

      {
        phone,
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
- Hablar en idioma del cliente.
- No inventar información.
- No repetir preguntas.
- Ayudar solamente si el flujo no está activo.

Operaciones:
- transferencia
- entrega
- recarga
`

      },

      {

        headers: {

          Authorization:
            `Bearer ${OPENAI_API_KEY}`,

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
   RESET ESTADO
========================= */

function resetEstado(phone) {

  estadoCliente[phone] = {

    operacion: null,

    etapa: "inicio",

    idioma: "es",

    moeda: null,
    monto: null,
    municipio: null,
    tarjeta: null,
    numero: null,

    aguardando: null,

    pixEnviado: false

  };

}

/* =========================
   WEBHOOK
========================= */

app.post("/webhook", async (req, res) => {

  try {

    const body = req.body;

    if (

      body.isGroup ||
      body.isNewsletter ||
      body.isEdit ||
      body.fromApi ||
      body.status !== "RECEIVED"

    ) {

      return res.sendStatus(200);

    }

    const texto =
      body?.text?.message || "";

    const phone =
      body.phone;

    if (!texto && !body.image) {

      return res.sendStatus(200);

    }

    const hora =
      new Date().getHours();

    if (hora >= 22 || hora < 6) {

      return res.sendStatus(200);

    }

    /* =========================
       PAUSA HUMANA
    ========================== */

    if (body.fromMe === true) {

      pausaHumana[phone] =
        Date.now() + (30 * 60 * 1000);

      return res.sendStatus(200);

    }

    if (

      pausaHumana[phone] &&
      Date.now() < pausaHumana[phone]

    ) {

      return res.sendStatus(200);

    }

    const textoLimpo =
      texto
        .toLowerCase()
        .replace(/[^\w\s]/gi, " ");

    /* =========================
       PEDIR HUMANO
    ========================== */

    if (

      textoLimpo.includes("yordanys") ||
      textoLimpo.includes("humano") ||
      textoLimpo.includes("operador")

    ) {

      pausaHumana[phone] =
        Date.now() + (30 * 60 * 1000);

      await enviarMensaje(

        phone,

        "Claro 👌 Yordanys continuará tu atención en breve."

      );

      return res.sendStatus(200);

    }

    /* =========================
       SAUDAÇÃO
    ========================== */

    const saudacao =
      saudacoes.some(s =>
        textoLimpo.includes(s)
      );

    const comercial =
      gatilhos.some(g =>
        textoLimpo.includes(g)
      );

    if (

      saudacao &&
      !comercial

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
       CONTEXTO
    ========================== */

    if (comercial) {

      conversaAtiva[phone] =
        Date.now() + (5 * 60 * 1000);

    }

    if (

      conversaAtiva[phone] &&
      Date.now() > conversaAtiva[phone]

    ) {

      delete conversaAtiva[phone];

      resetEstado(phone);

    }

    if (!estadoCliente[phone]) {

      resetEstado(phone);

    }

    let estado =
      estadoCliente[phone];

    /* =========================
       DETECTAR OPERAÇÃO
    ========================== */

    let novaOperacao = null;

    const mudarFluxo =

      textoLimpo.includes("cambiar") ||
      textoLimpo.includes("mejor");

    if (

      estado.etapa === "inicio" ||
      mudarFluxo

    ) {

      if (

        textoLimpo.includes("transferencia") ||
        textoLimpo.includes("transferir")

      ) {

        novaOperacao =
          "transferencia";

      }

      if (

        textoLimpo.includes("entrega") ||
        textoLimpo.includes("habana") ||
        textoLimpo.includes("efectivo")

      ) {

        novaOperacao =
          "entrega";

      }

      if (

        textoLimpo.includes("recarga") ||
        textoLimpo.includes("etecsa")

      ) {

        novaOperacao =
          "recarga";

      }

    }

    if (

      novaOperacao &&
      estado.operacion !== novaOperacao

    ) {

      if (estado.operacion) {

        await enviarMensaje(
          phone,
          "Entendido 👍 cambiando operación."
        );

      }

      resetEstado(phone);

      estadoCliente[phone].operacion =
        novaOperacao;

      estado =
        estadoCliente[phone];

    }

    /* =========================
       DETECTAR MONTO
    ========================== */

    const numero =
      texto.match(/\d+([.,]\d+)?/);

    if (

      numero &&

      (

        textoLimpo.includes("real") ||
        textoLimpo.includes("reales") ||
        textoLimpo.includes("brl") ||
        textoLimpo.includes("cup") ||
        textoLimpo.includes("usd")

      ) &&

      (

        estado.etapa === "esperando_monto" ||
        estado.etapa === "inicio"

      )

    ) {

      estado.monto =
        numero[0];

    }

    /* =========================
       DETECTAR TARJETA
    ========================== */

    const tarjeta =
      texto.replace(/\D/g, "");

    if (

      estado.etapa === "esperando_tarjeta" &&
      tarjeta.length >= 16

    ) {

      estado.tarjeta =
        tarjeta;

    }

    /* =========================
       DETECTAR MUNICIPIO
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

      if (

        estado.etapa === "esperando_municipio" &&
        textoLimpo.includes(m)

      ) {

        estado.municipio = m;

      }

    });

    /* =========================
       RECARGA NUMERO
    ========================== */

    if (

      estado.operacion === "recarga"

    ) {

      const numeroRecarga =
        texto.replace(/\D/g, "");

      if (

        estado.etapa === "esperando_numero" &&
        numeroRecarga.length >= 8 &&
        numeroRecarga.length <= 12

      ) {

        estado.numero =
          numeroRecarga;

      }

    }

    /* =========================
       TRANSFERENCIA
    ========================== */

    if (

      estado.operacion === "transferencia"

    ) {

      if (!estado.monto) {

        estado.etapa =
          "esperando_monto";

        await enviarMensaje(
          phone,
          "¿Cuántos reales deseas enviar?"
        );

        return res.sendStatus(200);

      }

      if (!estado.tarjeta) {

        estado.etapa =
          "esperando_tarjeta";

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

        estado.etapa =
          "esperando_comprovante";

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
       ENTREGA
    ========================== */

    if (

      estado.operacion === "entrega"

    ) {

      if (!estado.monto) {

        estado.etapa =
          "esperando_monto";

        await enviarMensaje(
          phone,
          "¿Cuántos reales deseas enviar?"
        );

        return res.sendStatus(200);

      }

      if (!estado.municipio) {

        estado.etapa =
          "esperando_municipio";

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

        estado.etapa =
          "esperando_comprovante";

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
       RECARGA
    ========================== */

    if (

      estado.operacion === "recarga"

    ) {

      if (!estado.monto) {

        estado.etapa =
          "esperando_monto";

        await enviarMensaje(
          phone,
          "¿De cuánto será la recarga?"
        );

        return res.sendStatus(200);

      }

      if (!estado.numero) {

        estado.etapa =
          "esperando_numero";

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

        estado.etapa =
          "esperando_comprovante";

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

      estado.etapa =
        "finalizado";

      resetEstado(phone);

      delete conversaAtiva[phone];

      return res.sendStatus(200);

    }

    /* =========================
       OPENAI CONTROLADO
    ========================== */

    if (

      estado.operacion &&
      estado.etapa !== "inicio" &&
      estado.etapa !== "finalizado"

    ) {

      return res.sendStatus(200);

    }

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

app.get("/", (req, res) => {

  res.send(
    "YordaBot ONLINE"
  );

});

app.listen(PORT, () => {

  console.log(
    "Servidor ONLINE na porta " + PORT
  );

});
