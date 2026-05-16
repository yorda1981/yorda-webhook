const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

// =====================================
// CONFIG
// =====================================

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY;

const ZAPI_URL =
  process.env.ZAPI_URL;

const ZAPI_CLIENT_TOKEN =
  process.env.ZAPI_CLIENT_TOKEN;

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT;

// =====================================
// MEMORIA CLIENTES
// =====================================

const clientes = {};

// =====================================
// DUPLICADAS
// =====================================

const mensagensProcessadas =
  new Set();

// =====================================
// TASAS
// =====================================

function taxaBRL(valor) {

  if (valor < 100) {
    return 100;
  }

  if (valor < 500) {
    return 115;
  }

  return 118;
}

// =====================================
// DETECTAR PIX
// =====================================

function detectarPix(texto) {

  const t =
    texto.toLowerCase();

  return (
    t.includes("pix") ||
    t.includes("llave pix") ||
    t.includes("chave pix") ||
    t.includes("manda pix") ||
    t.includes("envia pix") ||
    t.includes("quiero pagar") ||
    t.includes("quero pagar")
  );
}

// =====================================
// DETECTAR RECARGA
// =====================================

function detectarRecarga(texto) {

  const t =
    texto.toLowerCase();

  return (
    t.includes("recarga") ||
    t.includes("saldo") ||
    t.includes("telefone") ||
    t.includes("telefono")
  );
}

// =====================================
// EXTRAER REALES
// =====================================

function extraerReales(texto) {

  const regex =
    /(\d+)/g;

  const encontrados =
    texto.match(regex);

  if (!encontrados) {
    return null;
  }

  return parseInt(
    encontrados[0]
  );
}

// =====================================
// OPENAI
// =====================================

async function gerarResposta(
  mensagem
) {

  try {

    const resposta =
      await axios.post(

        "https://api.openai.com/v1/responses",

        {
          model:
            "gpt-4.1-mini",

          input: [

            {
              role: "system",
              content:
                SYSTEM_PROMPT
            },

            {
              role: "user",
              content:
                mensagem
            }
          ]
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

    return resposta.data
      ?.output?.[0]
      ?.content?.[0]
      ?.text;

  } catch (erro) {

    console.log(
      "ERRO OPENAI:"
    );

    console.log(
      erro.response?.data ||
      erro.message
    );

    return null;
  }
}

// =====================================
// ENVIAR WHATSAPP
// =====================================

async function enviarMensagem(
  numero,
  mensagem
) {

  try {

    await axios.post(

      ZAPI_URL,

      {
        phone: numero,
        message: mensagem
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

  } catch (erro) {

    console.log(
      "ERRO ZAPI:"
    );

    console.log(
      erro.message
    );
  }
}

// =====================================
// HOME
// =====================================

app.get("/", (req, res) => {

  res.send(
    "YordaBot ONLINE 🚀"
  );
});

// =====================================
// WEBHOOK
// =====================================

app.post(
  "/webhook",
  async (req, res) => {

    try {

      const body =
        req.body;

      // IGNORAR

      if (
        body.isGroup ||
        body.fromMe ||
        body.isNewsletter
      ) {

        return res.sendStatus(200);
      }

      // DUPLICADAS

      const messageId =
        body.messageId;

      if (
        mensagensProcessadas.has(
          messageId
        )
      ) {

        return res.sendStatus(200);
      }

      mensagensProcessadas.add(
        messageId
      );

      setTimeout(() => {

        mensagensProcessadas.delete(
          messageId
        );

      }, 600000);

      // TEXTO

      const mensagem =
        body.text?.message;

      const numero =
        body.phone;

      if (!mensagem) {

        return res.sendStatus(200);
      }

      console.log(
        "MENSAGEM:",
        mensagem
      );

      // =================================
      // MEMORIA
      // =================================

      if (!clientes[numero]) {

        clientes[numero] = {
          etapa: "inicio"
        };
      }

      // =================================
      // PIX
      // =================================

      if (
        detectarPix(
          mensagem
        )
      ) {

        clientes[numero]
        .etapa =
          "pagamento";

        await enviarMensagem(

          numero,

`PIX:
8becaaf5-f296-4cbc-a115-46e3d23b042a

Titular:
YORDANYS RAFAEL SOSA REYES

Banco:
Nubank (260)`
        );

        return res.sendStatus(200);
      }

      // =================================
      // RECARGA
      // =================================

      if (
        detectarRecarga(
          mensagem
        )
      ) {

        const valor =
          extraerReales(
            mensagem
          );

        if (valor) {

          const saldo =
            valor * 20;

          await enviarMensagem(

            numero,

`${valor} reales = ${saldo.toLocaleString()} CUP de saldo 📲`
          );

          return res.sendStatus(200);
        }
      }

      // =================================
      // REMESA
      // =================================

      if (
        mensagem
        .toLowerCase()
        .includes("reales")
      ) {

        const valor =
          extraerReales(
            mensagem
          );

        if (valor) {

          const taxa =
            taxaBRL(valor);

          const cup =
            valor * taxa;

          await enviarMensagem(

            numero,

`${valor} reales → ${cup.toLocaleString()} CUP 🔥`
          );

          return res.sendStatus(200);
        }
      }

      // =================================
      // OPENAI
      // =================================

      const resposta =
        await gerarResposta(
          mensagem
        );

      if (resposta) {

        await enviarMensagem(
          numero,
          resposta
        );
      }

      return res.sendStatus(200);

    } catch (erro) {

      console.log(
        "ERRO WEBHOOK:"
      );

      console.log(
        erro.message
      );

      return res.sendStatus(500);
    }
  }
);

// =====================================
// START
// =====================================

const PORT =
  process.env.PORT || 8080;

app.listen(PORT, () => {

  console.log(
    `Servidor ONLINE na porta ${PORT}`
  );
});
