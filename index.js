const express = require("express");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 8080;

/* =========================
   VARIABLES
========================= */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;

/* =========================
   GATILLOS
========================= */

const gatilhos = [
  "remesa",
  "remesas",
  "envio",
  "enviar",
  "recarga",
  "recargar",
  "saldo",
  "cambio",
  "taxa",
  "tasas",
  "cup",
  "usd",
  "dolar",
  "dólar",
  "pix",
  "transferencia",
  "transferir",
  "reales",
  "real",
  "dinero",
  "mlc",
  "etecsa",
  "cuba",
  "deposito",
  "depósito",
  "mandar",
  "money"
];

/* =========================
   PIX
========================= */

const PIX =
"8becaaf5-f296-4cbc-a115-46e3d23b042a";

/* =========================
   FUNCIONES
========================= */

function tieneGatillo(texto) {

  texto = texto.toLowerCase();

  return gatilhos.some(g =>
    texto.includes(g)
  );
}

function calcularCUP(valor) {

  valor = Number(valor);

  if (valor < 100) {
    return valor * 100;
  }

  if (valor >= 100 && valor <= 499) {
    return valor * 115;
  }

  return valor * 118;
}

function calcularRecarga(valor) {

  valor = Number(valor);

  return valor * 20;
}

async function enviarMensaje(numero, mensaje) {

  try {

    const url =
`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;

    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        phone: numero,
        message: mensaje
      })
    });

  } catch (error) {

    console.log("ERRO ZAPI:");
    console.log(error);

  }
}

/* =========================
   HOME
========================= */

app.get("/", (req, res) => {

  res.send("YordaBot ONLINE");

});

/* =========================
   WEBHOOK
========================= */

app.post("/webhook", async (req, res) => {

  try {

    console.log("BODY:", req.body);

    const body = req.body;

    const texto =
      body?.text?.message ||
      "";

    const numero =
      body?.phone;

    if (!texto || !numero) {

      return res.sendStatus(200);

    }

    console.log("MENSAGEM:", texto);

    const msg = texto.toLowerCase();

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

    /* =========================
       SAUDAÇÃO NORMAL
    ========================= */

    if (
      msg === "hola" ||
      msg === "oi" ||
      msg === "ola" ||
      msg === "bom dia" ||
      msg === "boa tarde" ||
      msg === "boa noite"
    ) {

      await enviarMensaje(
        numero,
        "Hola 👋 ¿Cómo puedo ayudarte?"
      );

      return res.sendStatus(200);
    }

    /* =========================
       SEM GATILHO
    ========================= */

    if (!tieneGatillo(msg)) {

      return res.sendStatus(200);

    }

    /* =========================
       FALAR COM YORDANYS
    ========================= */

    if (
      msg.includes("yordanys") ||
      msg.includes("humano") ||
      msg.includes("atendente")
    ) {

      await enviarMensaje(
        numero,
        "Claro 👍 Yordanys continuará contigo enseguida."
      );

      return res.sendStatus(200);
    }

    /* =========================
       PIX
    ========================= */

    if (
      msg.includes("pix")
    ) {

      await enviarMensaje(
        numero,
        PIX
      );

      return res.sendStatus(200);
    }

    /* =========================
       TAXAS
    ========================= */

    if (
      msg.includes("taxa") ||
      msg.includes("tasas") ||
      msg.includes("cambio")
    ) {

      await enviarMensaje(
        numero,
`Menos de 100 reales → 100 CUP
100-499 reales → 115 CUP
500+ reales → 118 CUP`
      );

      return res.sendStatus(200);
    }

    /* =========================
       RECARGA
    ========================= */

    if (
      msg.includes("recarga")
    ) {

      await enviarMensaje(
        numero,
        "¿De cuánto deseas la recarga?"
      );

      return res.sendStatus(200);
    }

    /* =========================
       MONTO + RECARGA
    ========================= */

    const recargaMatch =
      msg.match(/(\d+)/);

    if (
      recargaMatch &&
      msg.includes("recarga")
    ) {

      const valor =
        Number(recargaMatch[1]);

      const saldo =
        calcularRecarga(valor);

      await enviarMensaje(
        numero,
`${valor} reales = ${saldo.toLocaleString()} CUP de saldo 📲`
      );

      return res.sendStatus(200);
    }

    /* =========================
       CALCULO REALES
    ========================= */

    const match =
      msg.match(/(\d+)/);

    if (
      match &&
      (
        msg.includes("real") ||
        msg.includes("reales")
      )
    ) {

      const valor =
        Number(match[1]);

      const cup =
        calcularCUP(valor);

      await enviarMensaje(
        numero,
`${valor} reales → ${cup.toLocaleString()} CUP 🔥`
      );

      return res.sendStatus(200);
    }

    /* =========================
       OPENAI FALLBACK
    ========================= */

    const resposta = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Authorization":
`Bearer ${OPENAI_API_KEY}`,
          "Content-Type":
"application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: `Responde corto y profesional sobre remesas y recargas: ${texto}`
        })
      }
    );

    const data =
      await resposta.json();

    console.log(data);

    const respostaTexto =
      data?.output?.[0]?.content?.[0]?.text ||
      "No entendí. ¿Puedes explicarme mejor?";

    await enviarMensaje(
      numero,
      respostaTexto
    );

    return res.sendStatus(200);

  } catch (error) {

    console.log("ERRO GERAL:");
    console.log(error);

    return res.sendStatus(200);

  }

});

/* =========================
   START
========================= */

app.listen(PORT, () => {

  console.log(
`Servidor ONLINE na porta ${PORT}`
  );

});
