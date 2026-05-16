const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 8080;

/* =========================
   VARIABLES
========================= */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;

const ZAPI_URL =
  `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;

/* =========================
   GATILLOS
========================= */

const gatilhos = [
  "remesa",
  "remesas",
  "envio",
  "enviar",
  "reais",
  "real",
  "usd",
  "dolar",
  "dólar",
  "pix",
  "transferencia",
  "transferência",
  "saldo",
  "recarga",
  "etecsa",
  "cambio",
  "cmb",
  "cup",
  "mlc",
  "dinero",
  "money",
  "receber",
  "recibir",
  "deposito",
  "depósito",
  "tarjeta",
  "cartao",
  "cartão",
  "taxa",
  "tasas",
  "câmbio",
  "troca"
];

/* =========================
   FUNÇÕES
========================= */

function contieneGatilho(texto) {
  const t = texto.toLowerCase();

  return gatilhos.some(g => t.includes(g));
}

function calcularCUP(valor) {

  let taxa = 100;

  if (valor >= 100 && valor <= 499) {
    taxa = 115;
  }

  if (valor >= 500) {
    taxa = 118;
  }

  return {
    taxa,
    cup: valor * taxa
  };
}

async function enviarMensagem(phone, message) {

  try {

    await axios.post(
      ZAPI_URL,
      {
        phone,
        message
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

  } catch (err) {

    console.log("ERRO ZAPI:");

    if (err.response) {
      console.log(err.response.data);
    } else {
      console.log(err.message);
    }
  }
}

/* =========================
   WEBHOOK
========================= */

app.post("/", async (req, res) => {

  try {

    const body = req.body;

    console.log("BODY:");
    console.log(JSON.stringify(body, null, 2));

    const mensagem =
      body?.text?.message || "";

    const telefone =
      body?.phone || "";

    const fromMe =
      body?.fromMe || false;

    const isGroup =
      body?.isGroup || false;

    if (!mensagem) {
      return res.sendStatus(200);
    }

    console.log("MENSAGEM:", mensagem);

    /* IGNORAR */

    if (fromMe) {
      console.log("IGNORADO: própria");
      return res.sendStatus(200);
    }

    if (isGroup) {
      console.log("IGNORADO: grupo");
      return res.sendStatus(200);
    }

    const texto = mensagem.toLowerCase();

    /* SAUDAÇÃO */

    const saudacoes = [
      "oi",
      "ola",
      "olá",
      "hola",
      "bom dia",
      "boa tarde",
      "boa noite",
      "buenas",
      "buenos dias",
      "buenas noches"
    ];

    if (saudacoes.includes(texto)) {

      await enviarMensagem(
        telefone,
        "Olá 👋 Como posso ajudar?"
      );

      return res.sendStatus(200);
    }

    /* SEM GATILHO */

    const interessado = contieneGatilho(texto);

    if (!interessado) {

      console.log("SEM GATILHO");

      return res.sendStatus(200);
    }

    /* PIX */

    if (
      texto.includes("pix") &&
      (
        texto.includes("copiar") ||
        texto.includes("pagar") ||
        texto.includes("llave") ||
        texto.includes("clave")
      )
    ) {

      await enviarMensagem(
        telefone,
        "8becaaf5-f296-4cbc-a115-46e3d23b042a"
      );

      return res.sendStatus(200);
    }

    /* CÁLCULO REAIS */

    const matchReais =
      texto.match(/(\d+)/);

    if (
      matchReais &&
      (
        texto.includes("real") ||
        texto.includes("reais") ||
        texto.includes("cup")
      )
    ) {

      const valor =
        parseInt(matchReais[1]);

      const resultado =
        calcularCUP(valor);

      await enviarMensagem(
        telefone,
        `${valor} reais → ${resultado.cup.toLocaleString("pt-BR")} CUP 🔥`
      );

      return res.sendStatus(200);
    }

    /* RECARGA */

    if (
      texto.includes("recarga") ||
      texto.includes("saldo")
    ) {

      await enviarMensagem(
        telefone,
        "Recargas ETECSA disponíveis 📱"
      );

      return res.sendStatus(200);
    }

    /* FALAR COM YORDANYS */

    if (
      texto.includes("yordanys") ||
      texto.includes("atendente")
    ) {

      await enviarMensagem(
        telefone,
        "Claro 👍 Yordanys continuará contigo enseguida."
      );

      return res.sendStatus(200);
    }

    /* OPENAI */

    const respostaOpenAI = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: "gpt-4.1-mini",

        input: [
          {
            role: "system",
            content:
              "Você trabalha com remessas Brasil Cuba. Responda curto, natural e humano."
          },
          {
            role: "user",
            content: mensagem
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const resposta =
      respostaOpenAI.data.output_text ||
      "No entendí. ¿Puedes explicar mejor?";

    await enviarMensagem(
      telefone,
      resposta
    );

    return res.sendStatus(200);

  } catch (erro) {

    console.log("ERRO GERAL:");

    if (erro.response) {
      console.log(JSON.stringify(erro.response.data, null, 2));
    } else {
      console.log(erro.message);
    }

    return res.sendStatus(200);
  }
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(`Servidor ONLINE na porta ${PORT}`);
});
