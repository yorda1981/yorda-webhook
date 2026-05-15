const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

// ======================================
// PAUSA HUMANA PROFESIONAL
// ======================================

const pausados = {};

// 30 minutos
const TEMPO_PAUSA =
  30 * 60 * 1000;

// ======================================
// GATILHOS
// ======================================

const gatilhos = [
  "real",
  "reales",
  "cup",
  "usd",
  "dolar",
  "dólar",
  "pix",
  "transferencia",
  "transferência",
  "remesa",
  "recarga",
  "saldo",
  "cmb",
  "cambio",
  "mlc",
  "etecsa",
  "internet",
  "sms",
  "llamadas",
  "dinero",
  "tarjeta",
  "deposito",
  "depósito"
];

// ======================================
// HOME
// ======================================

app.get("/", (req, res) => {
  res.send(
    "YordaBot Workflow Online 🚀"
  );
});

// ======================================
// WEBHOOK
// ======================================

app.post("/webhook", async (req, res) => {

  try {

    console.log(req.body);

    // ==================================
    // IGNORAR GRUPOS
    // ==================================

    if (req.body.isGroup) {
      return res.sendStatus(200);
    }

    // ==================================
    // IGNORAR NEWSLETTER
    // ==================================

    if (req.body.isNewsletter) {
      return res.sendStatus(200);
    }

    // ==================================
    // IGNORAR STATUS
    // ==================================

    if (
      req.body.type ===
      "MessageStatusCallback"
    ) {
      return res.sendStatus(200);
    }

    // ==================================
    // DADOS
    // ==================================

    const mensagem =
      req.body.text?.message || "";

    const numero =
      req.body.phone || "";

    // ==================================
    // IGNORAR VAZIO
    // ==================================

    if (!mensagem || !numero) {
      return res.sendStatus(200);
    }

    // ==================================
    // YORDANYS RESPONDE
    // ==================================

    if (req.body.fromMe) {

      pausados[numero] =
        Date.now();

      console.log(
        "BOT PAUSADO:",
        numero
      );

      return res.sendStatus(200);
    }

    // ==================================
    // VERIFICAR PAUSA
    // ==================================

    if (pausados[numero]) {

      const tempoPassado =
        Date.now() -
        pausados[numero];

      // AINDA PAUSADO

      if (
        tempoPassado <
        TEMPO_PAUSA
      ) {

        console.log(
          "CONVERSA EM PAUSA:",
          numero
        );

        return res.sendStatus(200);
      }

      // REATIVAR BOT

      delete pausados[numero];

      console.log(
        "BOT REATIVADO:",
        numero
      );
    }

    // ==================================
    // GATILHOS
    // ==================================

    const textoLower =
      mensagem.toLowerCase();

    const ativarBot =
      gatilhos.some(g =>
        textoLower.includes(g)
      );

    // ==================================
    // SEM GATILHO
    // ==================================

    if (!ativarBot) {

      console.log(
        "SEM GATILHO:",
        mensagem
      );

      return res.sendStatus(200);
    }

    console.log(
      "BOT ATIVADO:",
      mensagem
    );

    // ==================================
    // CHAMAR WORKFLOW OPENAI
    // ==================================

    const respostaWorkflow =
      await axios.post(

        "https://api.openai.com/v1/responses",

        {
          model: "gpt-4o-mini",

          workflow: {
            id: process.env.WORKFLOW_ID
          },

          input: mensagem
        },

        {
          headers: {
            Authorization:
              `Bearer ${process.env.OPENAI_API_KEY}`,

            "Content-Type":
              "application/json"
          }
        }
      );

    // ==================================
    // RESPOSTA
    // ==================================

    const resposta =
      respostaWorkflow.data.output_text;

    console.log(
      "RESPOSTA:",
      resposta
    );

    // ==================================
    // NÃO RESPONDER VAZIO
    // ==================================

    if (
      !resposta ||
      resposta.trim() === ""
    ) {

      return res.sendStatus(200);
    }

    // ==================================
    // ENVIAR WHATSAPP
    // ==================================

    await axios.post(

      process.env.ZAPI_URL,

      {
        phone: numero,
        message: resposta
      },

      {
        headers: {

          "Client-Token":
            process.env.ZAPI_CLIENT_TOKEN,

          "Content-Type":
            "application/json"
        }
      }
    );

    return res.sendStatus(200);

  } catch (error) {

    console.log(
      error.response?.data ||
      error.message
    );

    return res.sendStatus(500);
  }
});

// ======================================
// START
// ======================================

const PORT =
  process.env.PORT || 8080;

app.listen(PORT, () => {

  console.log(
    `Servidor online porta ${PORT}`
  );

});
