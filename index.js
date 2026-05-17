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
  String(process.env.ZAPI_INSTANCE || "").trim();

const ZAPI_TOKEN =
  String(process.env.ZAPI_TOKEN || "").trim();

const ZAPI_CLIENT_TOKEN =
  String(process.env.ZAPI_CLIENT_TOKEN || "").trim();

const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET;

/* =========================
   MEMORIA RAM
========================= */

const pausaHumana = {};
const conversaAtiva = {};
const estadoCliente = {};

/* =========================
   CONSTANTES
========================= */

const PAUSA_HUMANA_MS =
  30 * 60 * 1000;

const CONVERSA_ATIVA_MS =
  5 * 60 * 1000;

const PIX_CHAVE =
  "8becaaf5-f296-4cbc-a115-46e3d23b042a";

const PIX_NOME =
  "YORDANYS RAFAEL SOSA REYES\nNubank";

const GATILHOS = [
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

const SAUDACOES = [
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

const MUNICIPIOS = [
  "habana",
  "centro habana",
  "habana vieja",
  "cerro",
  "boyeros",
  "arroyo naranjo",
  "marianao"
];

/* =========================
   HELPERS
========================= */

function resetEstado(phone) {

  estadoCliente[phone] = {

    operacion: null,
    etapa: "inicio",
    monto: null,
    municipio: null,
    tarjeta: null,
    numero: null,
    aguardando: null,
    pixEnviado: false

  };

}

function getEstado(phone) {

  if (!estadoCliente[phone]) {
    resetEstado(phone);
  }

  return estadoCliente[phone];

}

function escapeRegex(str) {

  return str.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

}

function contemPalavra(texto, palavra) {

  const segura =
    escapeRegex(palavra);

  return new RegExp(
    "(^|\\s)" + segura + "(\\s|$)",
    "i"
  ).test(texto);

}

function saudacaoPorHora(hora) {

  if (hora >= 6 && hora < 12) {
    return "Buen día 👋 ¿Cómo puedo ayudarte?";
  }

  if (hora >= 12 && hora < 20) {
    return "Buenas tardes 👋 ¿Cómo puedo ayudarte?";
  }

  return "Buenas noches 👋 ¿Cómo puedo ayudarte?";

}

/* =========================
   LIMPEZA RAM
========================= */

setInterval(() => {

  const agora = Date.now();

  for (const phone in conversaAtiva) {

    if (agora > conversaAtiva[phone]) {
      delete conversaAtiva[phone];
    }

  }

  for (const phone in pausaHumana) {

    if (agora > pausaHumana[phone]) {
      delete pausaHumana[phone];
    }

  }

  for (const phone in estadoCliente) {

    if (
      !conversaAtiva[phone] &&
      !pausaHumana[phone]
    ) {

      delete estadoCliente[phone];

    }

  }

}, 10 * 60 * 1000);

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
      "ERRO ZAPI:",
      error.response?.data || error.message
    );

  }

}

/* =========================
   OPENAI
========================= */

async function responderIA(mensagem, estado) {

  try {

    const response = await axios.post(

      "https://api.openai.com/v1/responses",

      {

        model: "gpt-4.1-mini",

        input:
`CONTEXTO:
${JSON.stringify(estado, null, 2)}

CLIENTE:
${mensagem}`,

        instructions:
`Eres YordaBot.

Asistente humano de remesas.

REGLAS:
- Responder corto
- Máximo 2 líneas
- Sonar natural
- Hablar idioma cliente
- No sonar IA`

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

    const textoIA =
      response.data?.output?.[0]?.content?.find(
        c => c.type === "output_text"
      )?.text;

    return textoIA || "Dime 👍";

  } catch (error) {

    console.log(
      "ERRO OPENAI:",
      error.response?.data || error.message
    );

    return "Dime 👍";

  }

}

/* =========================
   AUTORIZAÇÃO
========================= */

function verificarAutorizacao(
  req,
  res,
  next
) {

  if (!WEBHOOK_SECRET) {
    return next();
  }

  const headerSecret =
    req.headers["x-webhook-secret"];

  const queryToken =
    req.query.token;

  if (
    headerSecret === WEBHOOK_SECRET ||
    queryToken === WEBHOOK_SECRET
  ) {

    return next();

  }

  console.log(
    "AUTORIZAÇÃO NEGADA:",
    req.ip
  );

  return res.sendStatus(401);

}

/* =========================
   WEBHOOK
========================= */

app.post(
  "/webhook",
  verificarAutorizacao,

  async (req, res) => {

    try {

      const body = req.body;

      const phone =
        String(body.phone || "");

      /* =========================
         IGNORAR GRUPOS
      ========================== */

      if (
        body.isGroup === true ||
        body.isNewsletter === true ||
        body.isEdit === true ||
        phone.includes("-group")
      ) {

        console.log(
          "IGNORANDO GRUPO"
        );

        return res.sendStatus(200);

      }

      /* =========================
         ANTI LOOP
      ========================== */

      if (
        body.fromApi === true &&
        body.fromMe === true
      ) {

        return res.sendStatus(200);

      }

      /* =========================
         PAUSA HUMANA
      ========================== */

      if (
        body.fromMe === true &&
        !phone.includes("-group")
      ) {

        pausaHumana[phone] =
          Date.now() + PAUSA_HUMANA_MS;

        console.log(
          "PAUSA HUMANA:",
          phone
        );

        return res.sendStatus(200);

      }

      const texto =
        body?.text?.message || "";

      if (!texto || !phone) {
        return res.sendStatus(200);
      }

      /* =========================
         HORA
      ========================== */

      const hora = Number(

        new Date().toLocaleString(
          "en-US",
          {
            timeZone: "America/Sao_Paulo",
            hour: "2-digit",
            hour12: false
          }
        )

      );

      if (hora >= 22 || hora < 6) {
        return res.sendStatus(200);
      }

      /* =========================
         BOT PAUSADO
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

      const textoLimpo =
        texto
          .toLowerCase()
          .replace(/[^\w\s]/gi, " ");

      /* =========================
         HUMANO
      ========================== */

      if (
        textoLimpo.includes("yordanys") ||
        textoLimpo.includes("humano") ||
        textoLimpo.includes("operador")
      ) {

        pausaHumana[phone] =
          Date.now() + PAUSA_HUMANA_MS;

        await enviarMensaje(
          phone,
          "Claro 👌 Yordanys te atenderá en breve."
        );

        return res.sendStatus(200);

      }

      /* =========================
         COMERCIAL
      ========================== */

      const esComercial =
        GATILHOS.some(g =>
          contemPalavra(textoLimpo, g)
        );

      if (esComercial) {

        conversaAtiva[phone] =
          Date.now() + CONVERSA_ATIVA_MS;

      }

      const conversaEmAndamento =
        conversaAtiva[phone] &&
        Date.now() < conversaAtiva[phone];

      /* =========================
         SAUDAÇÃO
      ========================== */

      const esSaudacao =
        SAUDACOES.some(s =>
          contemPalavra(textoLimpo, s)
        );

      if (
        esSaudacao &&
        !esComercial &&
        !conversaEmAndamento
      ) {

        await enviarMensaje(
          phone,
          saudacaoPorHora(hora)
        );

        return res.sendStatus(200);

      }

      if (
        !esComercial &&
        !conversaEmAndamento
      ) {

        return res.sendStatus(200);

      }

      /* =========================
         ESTADO
      ========================== */

      let estado =
        getEstado(phone);

      /* =========================
         OPERACION
      ========================== */

      if (
        textoLimpo.includes("transferencia") ||
        textoLimpo.includes("transferir")
      ) {

        estado.operacion =
          "transferencia";

      }

      if (
        textoLimpo.includes("entrega") ||
        textoLimpo.includes("habana")
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
         MONTO
      ========================== */

      const matchMonto =
        texto.match(/\b\d{1,6}\b/);

      if (
        matchMonto &&
        estado.etapa ===
          "esperando_monto"
      ) {

        estado.monto =
          matchMonto[0];

      }

      /* =========================
         TARJETA
      ========================== */

      const numeros =
        texto.replace(/\D/g, "");

      if (
        estado.etapa ===
          "esperando_tarjeta" &&

        /^\d{16}$/.test(numeros)
      ) {

        estado.tarjeta =
          numeros;

      }

      /* =========================
         NUMERO
      ========================== */

      if (
        estado.etapa ===
          "esperando_numero" &&

        /^\d{8,11}$/.test(numeros)
      ) {

        estado.numero =
          numeros;

      }

      /* =========================
         MUNICIPIO
      ========================== */

      if (
        estado.etapa ===
          "esperando_municipio"
      ) {

        for (const m of MUNICIPIOS) {

          if (
            textoLimpo.includes(m)
          ) {

            estado.municipio = m;

          }

        }

      }

      /* =========================
         COMPROVANTE
      ========================== */

      if (

        estado.aguardando ===
          "comprovante" &&

        estado.pixEnviado &&

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

        resetEstado(phone);

        delete conversaAtiva[phone];

        return res.sendStatus(200);

      }

      /* =========================
         TRANSFERENCIA
      ========================== */

      if (
        estado.operacion ===
          "transferencia"
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

      }

      /* =========================
         ENTREGA
      ========================== */

      if (
        estado.operacion ===
          "entrega"
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

      }

      /* =========================
         RECARGA
      ========================== */

      if (
        estado.operacion ===
          "recarga"
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

      }

      /* =========================
         PIX
      ========================== */

      if (
        estado.operacion &&
        !estado.pixEnviado
      ) {

        estado.pixEnviado = true;

        estado.aguardando =
          "comprovante";

        estado.etapa =
          "esperando_comprovante";

        await enviarMensaje(
          phone,
          PIX_CHAVE
        );

        await enviarMensaje(
          phone,
          PIX_NOME
        );

        return res.sendStatus(200);

      }

      /* =========================
         OPENAI
      ========================== */

      const respostaIA =
        await responderIA(
          texto,
          estado
        );

      await enviarMensaje(
        phone,
        respostaIA
      );

      return res.sendStatus(200);

    } catch (error) {

      console.log(
        "ERRO GERAL:",
        error.response?.data ||
        error.message
      );

      return res.sendStatus(500);

    }

  }
);

/* =========================
   HEALTH
========================= */

app.get("/", (req, res) => {

  res.send("YordaBot ONLINE");

});

/* =========================
   START
========================= */

app.listen(PORT, () => {

  console.log(
    "Servidor ONLINE puerto " + PORT
  );

});
