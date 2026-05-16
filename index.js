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
   PIX
========================= */

const PIX =
"8becaaf5-f296-4cbc-a115-46e3d23b042a";

/* =========================
   GATILLOS
========================= */

const gatilhos = [
  "remesa",
  "remesas",
  "envio",
  "enviar",
  "transferencia",
  "transferência",
  "recarga",
  "saldo",
  "cambio",
  "taxa",
  "taxas",
  "cup",
  "usd",
  "dolar",
  "dólar",
  "pix",
  "real",
  "reales",
  "dinero",
  "mlc",
  "etecsa",
  "cuba"
];

/* =========================
   FUNÇÕES
========================= */

function temGatilho(texto) {

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

/* =========================
   ENVIAR MENSAGEM
========================= */

async function enviarMensaje(numero, mensaje) {

  try {

    const url =
`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;

    const resposta = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        phone: numero,
        message: mensaje
      })
    });

    const data = await resposta.text();

    console.log("ZAPI RESPOSTA:");
    console.log(data);

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

    console.log("BODY:");
    console.log(JSON.stringify(req.body, null, 2));

    const body = req.body;

    const numero =
      body.phone ||
      body.from ||
      body.sender ||
      "";

    const texto =
      body?.text?.message ||
      body?.text?.body ||
      body?.message ||
      "";

    console.log("NUMERO:", numero);
    console.log("MENSAGEM:", texto);

    if (!numero || !texto) {

      console.log("SEM DADOS");

      return res.sendStatus(200);

    }

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
       SAUDAÇÃO
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

    if (!temGatilho(msg)) {

      return res.sendStatus(200);

    }

    /* =========================
       YORDANYS
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
      msg.includes("taxas") ||
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

      const numeros =
        msg.match(/\d+/);

      if (numeros) {

        const valor =
          Number(numeros[0]);

        const saldo =
          calcularRecarga(valor);

        await enviarMensaje(
          numero,
`${valor} reales = ${saldo.toLocaleString()} CUP de saldo 📲`
        );

      } else {

        await enviarMensaje(
          numero,
          "¿De cuánto deseas la recarga?"
        );

      }

      return res.sendStatus(200);

    }

    /* =========================
       CALCULO REALES
    ========================= */

    const numeros =
      msg.match(/\d+/);

    if (
      numeros &&
      (
        msg.includes("real") ||
        msg.includes("reales")
      )
    ) {

      const valor =
        Number(numeros[0]);

      const cup =
        calcularCUP(valor);

      await enviarMensaje(
        numero,
`${valor} reales → ${cup.toLocaleString()} CUP 🔥`
      );

      return res.sendStatus(200);

    }

    /* =========================
       OPENAI
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
          input:
`Responde corto y profesional sobre remesas y recargas:
${texto}`
        })
      }
    );

    const data =
      await resposta.json();

    console.log("OPENAI:");
    console.log(JSON.stringify(data, null, 2));

    let respostaTexto =
      "No entendí. ¿Puedes explicarme mejor?";

    if (
      data.output &&
      data.output[0] &&
      data.output[0].content &&
      data.output[0].content[0]
    ) {

      respostaTexto =
        data.output[0].content[0].text ||
        respostaTexto;

    }

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
