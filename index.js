const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

// =====================================
// HOME
// =====================================

app.get("/", (req, res) => {

  res.send("Yorda-bot ONLINE 🚀");
});

// =====================================
// WEBHOOK
// =====================================

app.post("/webhook", async (req, res) => {

  try {

    console.log("BODY:");
    console.log(req.body);

    // =================================
    // IGNORAR GRUPOS
    // =================================

    if (req.body.isGroup) {

      console.log(
        "GRUPO IGNORADO"
      );

      return res.sendStatus(200);
    }

    // =================================
    // IGNORAR NEWSLETTER
    // =================================

    if (req.body.isNewsletter) {

      console.log(
        "NEWSLETTER IGNORADA"
      );

      return res.sendStatus(200);
    }

    // =================================
    // IGNORAR MENSAGENS DO BOT
    // =================================

    if (req.body.fromMe === true) {

      console.log(
        "MENSAGEM DO BOT IGNORADA"
      );

      return res.sendStatus(200);
    }

    // =================================
    // PEGAR NÚMERO
    // =================================

    const numero =
      req.body.phone;

    // =================================
    // PEGAR TEXTO
    // =================================

    const mensagem =
      req.body.text?.message || "";

    console.log(
      "MENSAGEM:",
      mensagem
    );

    if (!mensagem) {

      return res.sendStatus(200);
    }

    // =================================
    // OPENAI AGENT
    // =================================

    const respostaOpenAI =
      await axios.post(

        "https://api.openai.com/v1/responses",

        {
          model: "gpt-4.1-mini",

          assistant_id:
            process.env.OPENAI_AGENT_ID,

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

    console.log(
      "OPENAI COMPLETA:"
    );

    console.log(
      JSON.stringify(
        respostaOpenAI.data,
        null,
        2
      )
    );

    // =================================
    // PEGAR RESPOSTA
    // =================================

    let resposta = "";

    if (
      respostaOpenAI.data.output_text
    ) {

      resposta =
        respostaOpenAI.data
        .output_text;

    } else {

      resposta =
        respostaOpenAI.data
        ?.output?.[0]
        ?.content?.[0]
        ?.text || "";
    }

    console.log(
      "RESPOSTA FINAL:",
      resposta
    );

    if (!resposta) {

      console.log(
        "SEM RESPOSTA"
      );

      return res.sendStatus(200);
    }

    // =================================
    // ENVIAR WHATSAPP
    // =================================

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

    console.log(
      "ENVIADO COM SUCESSO"
    );

    return res.sendStatus(200);

  } catch (error) {

    console.log("ERRO:");

    console.log(
      error.response?.data ||
      error.message
    );

    return res.sendStatus(500);
  }
});

// =====================================
// START
// =====================================

const PORT =
  process.env.PORT || 8080;

app.listen(PORT, () => {

  console.log(
    `Servidor online na porta ${PORT}`
  );
});
