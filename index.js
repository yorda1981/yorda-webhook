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
  "Responde corto, humano y natural.";

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
    "cuanto"
  ];

  return gatilhos.some(
    palavra =>
      t.includes(
        palavra
      )
  );
}

// =====================================
// PIX
// =====================================

function detectarPix(texto) {

  const t =
    texto.toLowerCase();

  return (
    t.includes("pix") ||
    t.includes("llave pix") ||
    t.includes("chave pix") ||
    t.includes("pix para pagar") ||
    t.includes("quiero pagar") ||
    t.includes("quero pagar")
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

    const texto =
      resposta.data
      ?.output?.[0]
      ?.content?.[0]
      ?.text;

    return texto;

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

    console.log(
      "MENSAGEM ENVIADA"
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

      console.log(body);

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

      console.log(
        "MENSAGEM:",
        mensagem
      );

      const texto =
        mensagem
        .toLowerCase()
        .trim();

      // =================================
      // MEMORIA
      // =================================

      if (!clientes[numero]) {

        clientes[numero] = {
          comercial: false
        };
      }

      // =================================
      // SALUDO
      // =================================

      if (
        esSaludo(
          mensagem
        )
      ) {

        await enviarMensagem(

          numero,

          "Hola 👋 ¿Cómo puedo ayudarte?"
        );

        return res.sendStatus(200);
      }

      // =================================
      // DETECTAR COMERCIAL
      // =================================

      if (
        detectarComercial(
          mensagem
        )
      ) {

        clientes[numero]
        .comercial = true;
      }

      // =================================
      // PIX
      // =================================

      if (
        detectarPix(
          mensagem
        )
      ) {

        await enviarMensagem(

          numero,

`PIX:
8becaaf5-f296-4cbc-a115-46e3d23b042a`
        );

        return res.sendStatus(200);
      }

      // =================================
      // REMESAS
      // =================================

      if (
        texto === "remesa" ||
        texto === "remesas"
      ) {

        await enviarMensagem(

          numero,

          "Sí 👍 Hacemos remesas Brasil → Cuba. ¿Cuánto deseas enviar?"
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

        await enviarMensagem(

          numero,

`Menos de 100 reales → 100 CUP
100-499 reales → 115 CUP
500+ reales → 118 CUP`
        );

        return res.sendStatus(200);
      }

      // =================================
      // REAL
      // =================================

      if (
        texto === "real" ||
        texto === "reales"
      ) {

        await enviarMensagem(

          numero,

          "¿Cuántos reales deseas enviar?"
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

        await enviarMensagem(

          numero,

          "1 USD = 5.60 BRL 💵"
        );

        return res.sendStatus(200);
      }

      // =================================
      // RECARGAS
      // =================================

      if (
        texto.includes(
          "recarga"
        )
      ) {

        await enviarMensagem(

          numero,

          "Sí 👍 Hacemos recargas ETECSA. ¿De cuánto deseas la recarga?"
        );

        return res.sendStatus(200);
      }

      // =================================
      // CALCULO REALES
      // =================================

      if (
        texto.includes(
          "real"
        )
      ) {

        const valor =
          extraerNumero(
            texto
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
      // CALCULO USD
      // =================================

      if (
        texto.includes(
          "usd"
        )
      ) {

        const valor =
          extraerNumero(
            texto
          );

        if (valor) {

          const brl =
            valor * 5.6;

          await enviarMensagem(

            numero,

`${valor} USD = ${brl.toFixed(2)} BRL`
          );

          return res.sendStatus(200);
        }
      }

      // =================================
      // OPENAI SOLO SI ES NECESARIO
      // =================================

      if (
        clientes[numero]
        .comercial
      ) {

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
