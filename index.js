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
// CONTROLE
// =====================================

const mensagensProcessadas = new Set();

// =====================================
// HOME
// =====================================

app.get("/", (req, res) => {

  res.send("YordaBot ONLINE 🚀");
});

// =====================================
// GERAR RESPOSTA OPENAI
// =====================================

async function gerarResposta(
  mensagem,
  telefone
) {

  try {

    const resposta =
      await axios.post(

        "https://api.openai.com/v1/responses",

        {
          workflow: {
            id:
              "wf_68f65c9bd8648190a572e1272e6ae1880cf508aff8bcf40e"
          },

          input: mensagem,

          user: telefone
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
      "OPENAI COMPLETA:"
    );

    console.log(
      JSON.stringify(
        resposta.data,
        null,
        2
      )
    );

    let texto = "";

    if (
      resposta.data.output &&
      resposta.data.output.length > 0
    ) {

      for (
        const item of resposta.data.output
      ) {

        if (
          item.content &&
          item.content.length > 0
        ) {

          for (
            const conteudo of item.content
          ) {

            if (
              conteudo.text
            ) {

              texto =
                conteudo.text;

              break;
            }
          }
        }

        if (texto) break;
      }
    }

    texto =
      texto.trim();

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
      "MENSAGEM ENVIADA"
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
// WEBHOOK
// =====================================

app.post(
  "/webhook",
  async (req, res) => {

    try {

      console.log("BODY:");
      console.log(req.body);

      // ================================
      // IGNORAR GRUPOS
      // ================================

      if (
        req.body.isGroup
      ) {

        console.log(
          "GRUPO IGNORADO"
        );

        return res.sendStatus(200);
      }

      // ================================
      // IGNORAR NEWSLETTER
      // ================================

      if (
        req.body.isNewsletter
      ) {

        console.log(
          "NEWSLETTER IGNORADA"
        );

        return res.sendStatus(200);
      }

      // ================================
      // IGNORAR MENSAGENS DO BOT
      // ================================

      if (
        req.body.fromMe === true
      ) {

        console.log(
          "MENSAGEM DO BOT IGNORADA"
        );

        return res.sendStatus(200);
      }

      // ================================
      // PEGAR ID
      // ================================

      const messageId =
        req.body.messageId;

      if (
        mensagensProcessadas.has(
          messageId
        )
      ) {

        console.log(
          "MENSAGEM DUPLICADA IGNORADA"
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

      // ================================
      // PEGAR NÚMERO
      // ================================

      const numero =
        req.body.phone;

      // ================================
      // PEGAR TEXTO
      // ================================

      const mensagem =
        req.body.text?.message || "";

      console.log(
        "MENSAGEM:",
        mensagem
      );

      if (!mensagem) {

        return res.sendStatus(200);
      }

      // ================================
      // OPENAI
      // ================================

      const resposta =
        await gerarResposta(
          mensagem,
          numero
        );

      if (!resposta) {

        console.log(
          "SEM RESPOSTA"
        );

        return res.sendStatus(200);
      }

      // ================================
      // ENVIAR
      // ================================

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
