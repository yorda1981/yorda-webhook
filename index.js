const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 8080;

/* =========================
   CONFIG
========================= */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const AGENT_ID = process.env.AGENT_ID;

const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;

const ZAPI_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;

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
  "recibir",
  "receber",
  "deposito",
  "depósito",
  "tarjeta",
  "cartao",
  "cartão"
];

/* =========================
   FUNÇÃO
========================= */

function contieneGatilho(texto) {
  const t = texto.toLowerCase();

  return gatilhos.some(g => t.includes(g));
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
      body?.text?.message ||
      "";

    const telefone =
      body?.phone ||
      "";

    const fromMe =
      body?.fromMe ||
      false;

    const isGroup =
      body?.isGroup ||
      false;

    if (!mensagem) {
      return res.sendStatus(200);
    }

    console.log("MENSAGEM:", mensagem);

    /* IGNORAR */

    if (fromMe) {
      console.log("IGNORADO: mensagem própria");
      return res.sendStatus(200);
    }

    if (isGroup) {
      console.log("IGNORADO: grupo");
      return res.sendStatus(200);
    }

    /* SAUDAÇÃO NORMAL */

    const msgLower = mensagem.toLowerCase();

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

    const somenteSaudacao = saudacoes.includes(msgLower);

    if (somenteSaudacao) {

      await axios.post(ZAPI_URL, {
        phone: telefone,
        message: "Olá 👋 Como posso ajudar?"
      });

      return res.sendStatus(200);
    }

    /* DETECTAR INTERESSE */

    const interessado = contieneGatilho(mensagem);

    if (!interessado) {

      console.log("SEM GATILHO");

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
              "Você é um atendente humano de remessas e recargas. Responda curto, natural e direto."
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

    console.log("RESPOSTA:", resposta);

    /* ENVIAR */

    await axios.post(ZAPI_URL, {
      phone: telefone,
      message: resposta
    });

    return res.sendStatus(200);

  } catch (erro) {

    console.log("ERRO:");

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
