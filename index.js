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

// =====================================
// CONTROLE DUPLICADAS
// =====================================

const mensagensProcessadas =
  new Set();

// =====================================
// OPENAI WORKFLOW
// =====================================

async function gerarResposta(
  mensagem
) {

  try {

    const resposta =
      await axios.post(

        "https://api.openai.com/v1/responses",

        {
          workflow:
            "wf_68f65c9bd8648190a572e1272e6ae1880cf508aff8bcf40e",

          input: mensagem
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
      "OPENAI RESPONSE:"
    );

    console.log(
      JSON.stringify(
        resposta.data,
        null,
        2
      )
    );

    const texto =
      resposta.data
      ?.output?.[0]
      ?.content?.[0]
      ?.text || "";

    console.log(
      "RESPOSTA FINAL:",
      texto
    );

    return texto;

  } catch (erro) {

    console.log(
      "ERRO OPENAI:"
    );

    if (
      erro.response?.data
    ) {

      console.log(
        JSON.stringify(
          erro.response.data,
          null,
          2
        )
      );

    } else {

      console.log(
        erro.message
      );
    }

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
      "ENVIADO COM SUCESSO"
    );

  } catch (erro) {

    console.log(
      "ERRO ZAPI:"
    );

    if (
      erro.response?.data
    ) {

      console.log(
        JSON.stringify(
          erro.response.data,
          null,
          2
        )
      );

    } else {

      console.log(
        erro.message
      );
    }
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

      console.log("BODY:");
      console.log(req.body);

      // =================================
      // IGNORAR NEWSLETTER
      // =================================

      if (
        req.body.isNewsletter
      ) {

        console.log(
          "NEWSLETTER IGNORADA"
        );

        return res.sendStatus(200);
      }

      // =================================
      // IGNORAR GRUPOS
      // =================================

      if (
        req.body.isGroup
      ) {

        console.log(
          "GRUPO IGNORADO"
        );

        return res.sendStatus(200);
      }

      // =================================
      // IGNORAR MENSAGENS PRÓPRIAS
      // =================================

      if (
        req.body.fromMe === true
      ) {

        console.log(
          "MENSAGEM DO BOT IGNORADA"
        );

        return res.sendStatus(200);
      }

      // =================================
      // EVITAR DUPLICADAS
      // =================================

      const messageId =
        req.body.messageId;

      if (
        mensagensProcessadas.has(
          messageId
        )
      ) {

        console.log(
          "MENSAGEM DUPLICADA"
        );

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
        req.body.text?.message || "";

      const numero =
        req.body.phone;

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

      const resposta =
        await gerarResposta(
          mensagem
        );

      if (!resposta) {

        console.log(
          "SEM RESPOSTA"
        );

        return res.sendStatus(200);
      }

      // =================================
      // ENVIAR RESPOSTA
      // =================================

      await enviarMensagem(
        numero,
        resposta
      );

      return res.sendStatus(200);

    } catch (erro) {

      console.log(
        "ERRO WEBHOOK:"
      );

      if (
        erro.response?.data
      ) {

        console.log(
          JSON.stringify(
            erro.response.data,
            null,
            2
          )
        );

      } else {

        console.log(
          erro.message
        );
      }

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
