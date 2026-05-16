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
  "etecsa"

];

/* =========================
   MEMORIA
========================= */

const memoria = {};

/* =========================
   ENVIAR MENSAJE
========================= */

async function enviarMensaje(
  phone,
  texto
) {

  try {

    const url =
`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;

    const response =
      await axios.post(

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
      "ENVIADO:"
    );

    console.log(
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
   WEBHOOK
========================= */

app.post(
  "/webhook",
  async (req, res) => {

    try {

      const body =
        req.body;

      console.log(
        "BODY:",
        JSON.stringify(
          body,
          null,
          2
        )
      );

      /* =========================
         IGNORAR
      ========================= */

      if (

        body.fromMe === true ||
        body.isGroup === true ||
        body.isNewsletter === true ||
        body.image ||
        body.video ||
        body.audio ||
        body.document

      ) {

        console.log(
          "IGNORADO"
        );

        return res.sendStatus(200);

      }

      const phone =
        body.phone;

      const texto =
        body?.text?.message ||
        body?.text?.body ||
        "";

      if (!texto) {

        return res.sendStatus(200);

      }

      const msg =
        texto
        .toLowerCase()
        .trim();

      console.log(
        "MENSAGEM:",
        msg
      );

      /* =========================
         DETECTAR INTERES
      ========================= */

      const comercial =
        gatilhos.some(g =>
          msg.includes(g)
        );

      /* =========================
         SALUDO GENERAL
      ========================= */

      if (!comercial) {

        await enviarMensaje(
          phone,
          "Hola 👋 ¿Cómo puedo ayudarte?"
        );

        return res.sendStatus(200);

      }

      /* =========================
         YORDANYS
      ========================= */

      if (

        msg.includes(
          "yordanys"
        ) ||

        msg.includes(
          "humano"
        ) ||

        msg.includes(
          "atendente"
        )

      ) {

        await enviarMensaje(
          phone,
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
          phone,
          PIX
        );

        return res.sendStatus(200);

      }

      /* =========================
         TASAS
      ========================= */

      if (

        msg.includes(
          "tasa"
        ) ||

        msg.includes(
          "taxa"
        ) ||

        msg.includes(
          "cambio"
        ) ||

        msg.includes(
          "câmbio"
        )

      ) {

        await enviarMensaje(

          phone,

`💱 Tasas hoy:

Menos de 100 reales → 100 CUP

100 a 499 reales → 115 CUP

500+ reales → 118 CUP 🔥`

        );

        return res.sendStatus(200);

      }

      /* =========================
         RECARGA
      ========================= */

      if (

        msg.includes(
          "recarga"
        ) ||

        msg.includes(
          "saldo"
        ) ||

        msg.includes(
          "etecsa"
        )

      ) {

        memoria[phone] =
          "recarga";

        await enviarMensaje(
          phone,
          "¿De cuánto deseas la recarga?"
        );

        return res.sendStatus(200);

      }

      /* =========================
         TRANSFERENCIA
      ========================= */

      if (

        msg.includes(
          "transferencia"
        ) ||

        msg.includes(
          "transferência"
        ) ||

        msg.includes(
          "envio"
        ) ||

        msg.includes(
          "remesa"
        )

      ) {

        memoria[phone] =
          "transferencia";

        await enviarMensaje(
          phone,
          "¿Cuántos reales deseas enviar?"
        );

        return res.sendStatus(200);

      }

      /* =========================
         CALCULO
      ========================= */

      const numero =
        parseFloat(
          msg.replace(",", ".")
        );

      if (!isNaN(numero)) {

        /* =========================
           RECARGA
        ========================= */

        if (
          memoria[phone] ===
          "recarga"
        ) {

          const cup =
            numero * 100;

          await enviarMensaje(

            phone,

`${numero} reales = ${cup.toLocaleString()} CUP de saldo 📲`

          );

          return res.sendStatus(200);

        }

        /* =========================
           TRANSFERENCIA
        ========================= */

        if (
          memoria[phone] ===
          "transferencia"
        ) {

          let tasa = 100;

          if (
            numero >= 100 &&
            numero < 500
          ) {

            tasa = 115;

          }

          if (
            numero >= 500
          ) {

            tasa = 118;

          }

          const cup =
            numero * tasa;

          await enviarMensaje(

            phone,

`${numero} reales = ${cup.toLocaleString()} CUP 💸`

          );

          return res.sendStatus(200);

        }

      }

      /* =========================
         OPENAI
      ========================= */

      const respuesta =
        await axios.post(

          "https://api.openai.com/v1/responses",

          {

            model:
              "gpt-4.1-mini",

            input:
`Cliente escribió:
"${texto}"

Responde corto y natural.
Solo sobre remesas, recargas o cambio.`

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

      console.log(
        "OPENAI:",
        JSON.stringify(
          respuesta.data,
          null,
          2
        )
      );

      const reply =
        respuesta.data.output_text ||
        "¿Cómo puedo ayudarte?";

      await enviarMensaje(
        phone,
        reply
      );

      return res.sendStatus(200);

    } catch (error) {

      console.log(
        "ERRO GERAL"
      );

      console.log(
        error.response?.data ||
        error.message
      );

      return res.sendStatus(500);

    }

  }

);

/* =========================
   ONLINE
========================= */

app.get("/", (req, res) => {

  res.send(
    "YordaBot ONLINE"
  );

});

app.listen(PORT, () => {

  console.log(
`Servidor ONLINE na porta ${PORT}`
  );

});
