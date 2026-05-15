const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Yorda-Bot Workflow Online 🚀");
});

app.post("/webhook", async (req, res) => {

  try {

    console.log(req.body);

    // IGNORAR GRUPOS
    if (req.body.isGroup) {
      return res.sendStatus(200);
    }

    // IGNORAR STATUS
    if (
      req.body.type ===
      "MessageStatusCallback"
    ) {
      return res.sendStatus(200);
    }

    // IGNORAR NEWSLETTER
    if (req.body.isNewsletter) {
      return res.sendStatus(200);
    }

    const mensagem =
      req.body.text?.message || "";

    const numero =
      req.body.phone || "";

    if (!mensagem || !numero) {
      return res.sendStatus(200);
    }

    // CHAMAR WORKFLOW OPENAI

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

    const resposta =
      respostaWorkflow.data.output_text;

    console.log(
      "RESPOSTA:",
      resposta
    );

    // NÃO RESPONDER VAZIO
    if (
      !resposta ||
      resposta.trim() === ""
    ) {
      return res.sendStatus(200);
    }

    // ENVIAR WHATSAPP

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

const PORT =
  process.env.PORT || 8080;

app.listen(PORT, () => {

  console.log(
    `Servidor online porta ${PORT}`
  );

});
