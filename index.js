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
  process.env.SYSTEM_PROMPT ||
  "Responde corto y natural.";

// =====================================
// MEMORIA
// =====================================

const clientes = {};

// =====================================
// DUPLICADAS
// =====================================

const mensagensProcessadas =
  new Set();

// =====================================
// TAXAS
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
// EXTRAER NUMERO
// =====================================

function extraerNumero(texto) {

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
// SALUDO
// =====================================

function esSaludo(texto) {

  const t =
    texto.toLowerCase().trim();

  return (
    t === "hola" ||
    t === "oi" ||
    t === "ola" ||
    t === "hello" ||
    t === "buenas" ||
    t === "boa noite" ||
    t === "boa tarde" ||
    t === "buen día" ||
    t === "buen dia" ||
    t === "buenos días" ||
    t === "buenos dias" ||
    t === "buenas tardes"
  );
}

// =====================================
// DETECTAR COMERCIAL
// =====================================

function detectarComercial(
  texto
) {

  const t =
    texto.toLowerCase();

  const gatilhos = [

    "real",
    "reales",
    "brl",

    "usd",
    "dolar",
    "dólar",

    "cup",
    "mlc",

    "pix",
    "llave",
    "chave",

    "transferencia",
    "transferência",

    "deposito",
    "depósito",

    "saldo",

    "remesa",
    "remesas",

    "envio",
    "enviar",

    "mandar",
    "receber",
    "recibir",

    "cambio",
    "cmb",

    "taxa",
    "taxas",
    "tasa",
    "tasas",

    "etecsa",

    "recarga",
    "recargas",

    "internet",
    "sms",
    "llamadas",

    "dinero",
    "money",

    "tarjeta",

    "cuba",
    "habana",
    "granma",
    "santiago",

    "pagar",
    "pago",

    "comprovante",
    "comprobante",

    "quanto",
    "cuanto",

    "yordanys",
    "humano",
    "atendente"
  ];

  return gatilhos.some(
    palavra =>
      t.includes(
        palavra
      )
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
                String(
                  SYSTEM_PROMPT
                )
            },

            {
              role: "user",
              content:
                String(
                  mensagem
                )
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
      erro.response?.data ||
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

      // =================================
      // IGNORAR
      // =================================

      if (
        body.isGroup ||
        body.fromMe ||
        body.isNewsletter
      ) {

        return res.sendStatus(200);
      }

      // =================================
      // DUPLICADAS
      // =================================

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

      // =================================
      // TEXTO
      // =================================

      const mensagem =
        body.text?.message;

      const numero =
        body.phone;

      if (!mensagem) {

        return res.sendStatus(200);
      }

      const texto =
        mensagem
        .toLowerCase()
        .trim();

      console.log(
        "MENSAGEM:",
        texto
      );

      // =================================
      // CLIENTE
      // =================================

      if (!clientes[numero]) {

        clientes[numero] = {

          comercial: false,

          modo: "normal",

          ultimaMensagem: "",

          ultimaResposta: ""
        };
      }

      // =================================
      // EVITAR REPETICION
      // =================================

      if (
        clientes[numero]
        .ultimaMensagem === texto
      ) {

        return res.sendStatus(200);
      }

      clientes[numero]
      .ultimaMensagem = texto;

      // =================================
      // MODO HUMANO
      // =================================

      if (
        clientes[numero]
        .modo === "humano"
      ) {

        return res.sendStatus(200);
      }

      // =================================
      // SALUDO
      // =================================

      if (
        esSaludo(texto)
      ) {

        const resposta =
          "Hola 👋 ¿Cómo puedo ayudarte?";

        clientes[numero]
        .ultimaResposta = resposta;

        await enviarMensagem(
          numero,
          resposta
        );

        return res.sendStatus(200);
      }

      // =================================
      // DETECTAR COMERCIAL
      // =================================

      if (
        detectarComercial(
          texto
        )
      ) {

        clientes[numero]
        .comercial = true;
      }

      // =================================
      // HUMANO
      // =================================

      if (
        texto.includes(
          "yordanys"
        ) ||
        texto.includes(
          "humano"
        ) ||
        texto.includes(
          "atendente"
        )
      ) {

        clientes[numero]
        .modo = "humano";

        const resposta =
          "Claro 👍 Yordanys continuará contigo enseguida.";

        clientes[numero]
        .ultimaResposta = resposta;

        await enviarMensagem(
          numero,
          resposta
        );

        return res.sendStatus(200);
      }

      // =================================
      // REMESA
      // =================================

      if (
        texto.includes(
          "remesa"
        ) ||
        texto.includes(
          "envio"
        ) ||
        texto.includes(
          "enviar"
        )
      ) {

        clientes[numero]
        .modo = "remesa";

        const resposta =
          "¿Cuántos reales deseas enviar?";

        clientes[numero]
        .ultimaResposta = resposta;

        await enviarMensagem(
          numero,
          resposta
        );

        return res.sendStatus(200);
      }

      // =================================
      // RECARGA
      // =================================

      if (
        texto.includes(
          "recarga"
        )
      ) {

        clientes[numero]
        .modo = "recarga";

        const resposta =
          "¿De cuánto deseas la recarga?";

        clientes[numero]
        .ultimaResposta = resposta;

        await enviarMensagem(
          numero,
          resposta
        );

        return res.sendStatus(200);
      }

      // =================================
      // PIX
      // =================================

      if (
        texto.includes(
          "pix"
        )
      ) {

        const resposta =
`PIX:
8becaaf5-f296-4cbc-a115-46e3d23b042a`;

        clientes[numero]
        .ultimaResposta = resposta;

        await enviarMensagem(
          numero,
          resposta
        );

        return res.sendStatus(200);
      }

      // =================================
      // TAXAS
      // =================================

      if (
        texto === "taxa" ||
        texto === "taxas" ||
        texto === "tasa" ||
        texto === "tasas" ||
        texto === "cambio"
      ) {

        const resposta =
`Menos de 100 reales → 100 CUP
100-499 reales → 115 CUP
500+ reales → 118 CUP`;

        clientes[numero]
        .ultimaResposta = resposta;

        await enviarMensagem(
          numero,
          resposta
        );

        return res.sendStatus(200);
      }

      // =================================
      // USD
      // =================================

      if (
        texto === "usd" ||
        texto === "dolar" ||
        texto === "dólar"
      ) {

        const resposta =
          "1 USD = 5.60 BRL 💵";

        clientes[numero]
        .ultimaResposta = resposta;

        await enviarMensagem(
          numero,
          resposta
        );

        return res.sendStatus(200);
      }

      // =================================
      // EXTRAER NUMERO
      // =================================

      const valor =
        extraerNumero(
          texto
        );

      // =================================
      // RECARGA CALCULO
      // =================================

      if (
        clientes[numero]
        .modo === "recarga"
      ) {

        if (valor) {

          const saldo =
            valor * 20;

          const resposta =
`${valor} reales = ${saldo.toLocaleString()} CUP de saldo 📲`;

          clientes[numero]
          .ultimaResposta = resposta;

          await enviarMensagem(
            numero,
            resposta
          );

          return res.sendStatus(200);
        }
      }

      // =================================
      // REMESA CALCULO
      // =================================

      if (
        clientes[numero]
        .modo === "remesa"
      ) {

        if (valor) {

          const taxa =
            taxaBRL(valor);

          const cup =
            valor * taxa;

          const resposta =
`${valor} reales → ${cup.toLocaleString()} CUP 🔥`;

          clientes[numero]
          .ultimaResposta = resposta;

          await enviarMensagem(
            numero,
            resposta
          );

          return res.sendStatus(200);
        }
      }

      // =================================
      // OPENAI SOLO SECUNDARIO
      // =================================

      if (
        clientes[numero]
        .comercial
      ) {

        const resposta =
          await gerarResposta(
            mensagem
          );

        if (
          resposta &&
          resposta !==
          clientes[numero]
          .ultimaResposta
        ) {

          clientes[numero]
          .ultimaResposta = resposta;

          await enviarMensagem(
            numero,
            resposta
          );
        }
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
