const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

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
// CLIENTES JSON
// =====================================

const clientesPath = path.join(
  __dirname,
  "datos",
  "clientes.json"
);

function carregarClientes() {

  try {

    const dados =
      fs.readFileSync(
        clientesPath,
        "utf8"
      );

    return JSON.parse(dados);

  } catch {

    return {};
  }
}

function salvarClientes(clientes) {

  fs.writeFileSync(
    clientesPath,
    JSON.stringify(
      clientes,
      null,
      2
    )
  );
}

let clientes =
  carregarClientes();

// =====================================
// CONTROLE DUPLICADAS
// =====================================

const mensagensProcessadas =
  new Set();

// =====================================
// DETECTAR IDIOMA
// =====================================

function detectarIdioma(
  texto
) {

  const espanhol = [
    "hola",
    "quiero",
    "reales",
    "usd",
    "cup",
    "tasa",
    "transferencia",
    "tarjeta",
    "envio",
    "remesa"
  ];

  const textoLower =
    texto.toLowerCase();

  for (const palavra of espanhol) {

    if (
      textoLower.includes(
        palavra
      )
    ) {

      return "es";
    }
  }

  return "pt";
}

// =====================================
// OPENAI
// =====================================

async function gerarResposta(
  numero,
  mensagem
) {

  try {

    const cliente =
      clientes[numero];

    const contexto = `
Você é um atendente de remessas.

Idioma do cliente:
${cliente.idioma}

Mensagem:
${mensagem}

Responda normalmente ao cliente.
`;

    console.log(
      "CONTEXTO ENVIADO:"
    );

    console.log(
      contexto
    );

    const resposta =
      await axios.post(

        "https://api.openai.com/v1/responses",

        {
          model:
            "gpt-4.1-mini",

          input:
            contexto
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
      "RESPOSTA OPENAI:"
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
      ?.text;

    console.log(
      "TEXTO FINAL:",
      texto
    );

    return texto || "Olá 👋";

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

    return "Erro ao responder.";
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

      if (
        req.body.isNewsletter
      ) {

        return res.sendStatus(200);
      }

      if (
        req.body.isGroup
      ) {

        return res.sendStatus(200);
      }

      if (
        req.body.fromMe === true
      ) {

        return res.sendStatus(200);
      }

      const messageId =
        req.body.messageId;

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
      // CLIENTE
      // =================================

      if (!clientes[numero]) {

        clientes[numero] = {

          idioma:
            detectarIdioma(
              mensagem
            ),

          estado:
            "normal",

          ultimaInteracao:
            new Date()
            .toISOString()
        };

        salvarClientes(
          clientes
        );

        console.log(
          "CLIENTE SALVO"
        );
      }

      clientes[numero]
      .ultimaInteracao =
        new Date()
        .toISOString();

      salvarClientes(
        clientes
      );

      // =================================
      // GERAR RESPOSTA
      // =================================

      const resposta =
        await gerarResposta(
          numero,
          mensagem
        );

      console.log(
        "ENVIANDO:",
        resposta
      );

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
