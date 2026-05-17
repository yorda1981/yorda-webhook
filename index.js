const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 8080;

/* =========================
   VARIABLES
========================= */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ZAPI_INSTANCE  = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN     = process.env.ZAPI_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/* =========================
   MEMORIA RAM
========================= */

const pausaHumana   = {};
const conversaAtiva = {};
const estadoCliente = {};

/* =========================
   CONSTANTES
========================= */

const PAUSA_HUMANA_MS   = 30 * 60 * 1000;
const CONVERSA_ATIVA_MS = 5 * 60 * 1000;

const PIX_CHAVE =
  "8becaaf5-f296-4cbc-a115-46e3d23b042a";

const PIX_NOME =
  "YORDANYS RAFAEL SOSA REYES\nNubank";

const GATILHOS = [
  "remesa", "remesas",
  "envio", "enviar",
  "transferencia",
  "transferência",
  "transferir",
  "cambio", "câmbio",
  "tasa", "taxa",
  "tasas", "taxas",
  "real", "reales",
  "brl", "cup",
  "usd",
  "dolar", "dólar",
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
    moeda: null,
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
  const segura = escapeRegex(palavra);

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

  console.log(
    "RAM LIMPIA:",
    Object.keys(estadoCliente).length
  );

}, 10 * 60 * 1000);

/* =========================
   ENVIAR WHATSAPP
========================= */

async function enviarMensaje(phone, texto) {

  try {

    const url =
      `https://api.z-api.io/instances/${String(ZAPI_INSTANCE).trim()}/token/${String(ZAPI_TOKEN).trim()}/send-text`;

    const response = await axios.post(
      url,
      {
        phone,
        message: texto
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    console.log("ENVIADO:", response.data);

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
- No sonar como IA
- Hablar en idioma del cliente
- No repetir preguntas
- No pedir datos ya informados`
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
   DETECTORES
========================= */

function detectarOperacion(texto) {

  if (
    texto.includes("recarga") ||
    texto.includes("etecsa")
  ) {
    return "recarga";
  }

  if (
    texto.includes("transferencia") ||
    texto.includes("transferir")
  ) {
    return "transferencia";
  }

  if (
    texto.includes("entrega") ||
    texto.includes("habana") ||
    texto.includes("efectivo")
  ) {
    return "entrega";
  }

  return null;
}

function detectarMonto(texto, estado) {

  const match =
    texto.match(/\b\d{1,6}([.,]\d{1,2})?\b/);

  if (match) {
    estado.monto = match[0];
  }

}

function detectarTarjeta(texto, estado) {

  const numeros =
    texto.replace(/\D/g, "");

  if (/^\d{16}$/.test(numeros)) {
    estado.tarjeta = numeros;
  }

}

function detectarNumero(texto, estado) {

  const numeros =
    texto.replace(/\D/g, "");

  if (/^\d{8,11}$/.test(numeros)) {
    estado.numero = numeros;
  }

}

function detectarMunicipio(texto, estado) {

  for (const m of MUNICIPIOS) {

    if (texto.includes(m)) {
      estado.municipio = m;
      return;
    }

  }

}

/* =========================
   PIX
========================= */

async function enviarPix(phone, estado) {

  estado.etapa = "esperando_comprovante";
  estado.pixEnviado = true;
  estado.aguardando = "comprovante";

  await enviarMensaje(phone, PIX_CHAVE);
  await enviarMensaje(phone, PIX_NOME);

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

      if (
        body.fromApi === true &&
        body.fromMe === true
      ) {
        return res.sendStatus(200);
      }

      if (body.fromMe === true) {

        pausaHumana[body.phone] =
          Date.now() + PAUSA_HUMANA_MS;

        console.log(
          "PAUSA HUMANA:",
          body.phone
        );

        return res.sendStatus(200);
      }

      if (
        body.isGroup === true ||
        body.isNewsletter === true ||
        body.isEdit === true
      ) {
        return res.sendStatus(200);
      }

      const texto =
        body?.text?.message || "";

      const phone = body.phone;

      if (!texto || !phone) {
        return res.sendStatus(200);
      }

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

      console.log("MENSAGEM:", texto);

      const textoLimpo =
        texto
          .toLowerCase()
          .replace(/[^\w\s]/gi, " ");

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

      let estado = getEstado(phone);

      const operacion =
        detectarOperacion(textoLimpo);

      if (
        operacion &&
        operacion !== estado.operacion
      ) {

        resetEstado(phone);

        estadoCliente[phone].operacion =
          operacion;

        estado =
          estadoCliente[phone];

      }

      detectarMonto(texto, estado);
      detectarTarjeta(texto, estado);
      detectarNumero(texto, estado);
      detectarMunicipio(textoLimpo, estado);

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

      if (estado.operacion === "transferencia") {

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

          await enviarPix(
            phone,
            estado
          );

          return res.sendStatus(200);

        }

      }

      /* =========================
         ENTREGA
      ========================== */

      if (estado.operacion === "entrega") {

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

          await enviarPix(
            phone,
            estado
          );

          return res.sendStatus(200);

        }

      }

      /* =========================
         RECARGA
      ========================== */

      if (estado.operacion === "recarga") {

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

          await enviarPix(
            phone,
            estado
          );

          return res.sendStatus(200);

        }

      }

      /* =========================
         OPENAI FALLBACK
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
