```javascript
const express = require("express");
const axios = require("axios");
const fs = require("fs");

const app = express();

app.use(express.json());

// ======================================
// CONFIG
// ======================================

const TEMPO_PAUSA =
  30 * 60 * 1000;

const TEMPO_SALUDO =
  6 * 60 * 60 * 1000;

// ======================================
// MEMÓRIA
// ======================================

const pausados = {};

const ARQUIVO_CLIENTES =
  "./clientes.json";

// ======================================
// CRIAR JSON
// ======================================

if (
  !fs.existsSync(
    ARQUIVO_CLIENTES
  )
) {

  fs.writeFileSync(
    ARQUIVO_CLIENTES,
    "[]"
  );
}

// ======================================
// LER CLIENTES
// ======================================

function lerClientes() {

  try {

    return JSON.parse(

      fs.readFileSync(
        ARQUIVO_CLIENTES,
        "utf8"
      )
    );

  } catch {

    return [];
  }
}

// ======================================
// SALVAR CLIENTES
// ======================================

function salvarClientes(
  clientes
) {

  fs.writeFileSync(

    ARQUIVO_CLIENTES,

    JSON.stringify(
      clientes,
      null,
      2
    )
  );
}

// ======================================
// GATILHOS
// ======================================

const gatilhos = [

  "real",
  "reales",
  "taxa",
  "tasa",
  "cambio",
  "cmb",
  "cup",
  "usd",
  "dolar",
  "dólar",
  "mlc",
  "pix",
  "transferencia",
  "transferência",
  "remesa",
  "envio",
  "enviar",
  "mandar",
  "recarga",
  "saldo",
  "etecsa",
  "internet",
  "sms",
  "llamadas",
  "dinero",
  "tarjeta",
  "deposito",
  "depósito",
  "valor",
  "cotizacion",
  "cotização"
];

// ======================================
// HOME
// ======================================

app.get("/", (req, res) => {

  res.send(
    "YordaBot Online 🚀"
  );
});

// ======================================
// WEBHOOK
// ======================================

app.post(
  "/webhook",
  async (req, res) => {

    try {

      console.log(req.body);

      // ================================
      // IGNORAR GRUPOS
      // ================================

      if (req.body.isGroup) {

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
      // IGNORAR STATUS
      // ================================

      if (

        req.body.type ===
        "MessageStatusCallback"

      ) {

        return res.sendStatus(200);
      }

      // ================================
      // DADOS
      // ================================

      const numero =
        req.body.phone || "";

      const mensagem =
        req.body.text?.message || "";

      const nomeWhatsapp =
        req.body.senderName ||
        "Cliente";

      if (!numero) {

        return res.sendStatus(200);
      }

      // ================================
      // TEXTO
      // ================================

      const textoLower =
        mensagem
          .toLowerCase()
          .trim();

      console.log(
        "MENSAGEM:",
        textoLower
      );

      // ================================
      // DETECTAR IDIOMA
      // ================================

      let idioma = "es";

      const palavrasPT = [

        "oi",
        "olá",
        "você",
        "voce",
        "quanto",
        "pix",
        "obrigado",
        "boa tarde",
        "bom dia",
        "boa noite",
        "cadastro"
      ];

      const detectarPT =
        palavrasPT.some(p =>
          textoLower.includes(p)
        );

      if (detectarPT) {

        idioma = "pt";
      }

      console.log(
        "IDIOMA:",
        idioma
      );

      // ================================
      // MIDIA
      // ================================

      const temImagem =
        !!req.body.image;

      const imagemUrl =
        req.body.image?.imageUrl ||
        null;

      const temDocumento =
        !!req.body.document;

      const temAudio =
        !!req.body.audio;

      const temMidia =

        temImagem ||
        temDocumento ||
        temAudio;

      console.log(
        "TEM MIDIA:",
        temMidia
      );

      // ================================
      // PAUSA HUMANA
      // ================================

      if (

        req.body.fromMe &&
        !req.body.fromApi

      ) {

        pausados[numero] =
          Date.now();

        console.log(
          "CONVERSA PAUSADA PELO HUMANO:",
          numero
        );

        return res.sendStatus(200);
      }

      // ================================
      // VERIFICAR PAUSA
      // ================================

      if (pausados[numero]) {

        const tempoPassado =

          Date.now() -
          pausados[numero];

        if (

          tempoPassado <
          TEMPO_PAUSA

        ) {

          console.log(
            "CONVERSA PAUSADA:",
            numero
          );

          return res.sendStatus(200);
        }

        delete pausados[numero];

        console.log(
          "BOT REATIVADO:",
          numero
        );
      }

      // ================================
      // CLIENTES
      // ================================

      let clientes =
        lerClientes();

      let cliente =
        clientes.find(
          c => c.numero === numero
        );

      if (!cliente) {

        cliente = {

          numero,

          nome:
            nomeWhatsapp,

          idioma,

          ultimaMensagem:
            mensagem,

          ultimoContato:
            new Date()
              .toISOString(),

          ultimoSaludo: 0
        };

        clientes.push(cliente);

        console.log(
          "NOVO CLIENTE"
        );
      }

      else {

        console.log(
          "CLIENTE EXISTENTE"
        );
      }

      cliente.nome =
        nomeWhatsapp;

      cliente.idioma =
        idioma;

      cliente.ultimaMensagem =
        mensagem;

      cliente.ultimoContato =
        new Date()
          .toISOString();

      salvarClientes(
        clientes
      );

      // ================================
      // MIDIA / OCR
      // ================================

      if (temMidia) {

        const respostaMidia =

          idioma === "pt"

            ? "Comprovante recebido ✅\nEstou verificando o pagamento."

            : "Comprobante recibido ✅\nEstoy verificando el pago.";

        await new Promise(resolve =>
          setTimeout(resolve, 3000)
        );

        await axios.post(

          process.env.ZAPI_URL,

          {
            phone: numero,
            message: respostaMidia
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
          "COMPROVANTE RESPONDIDO"
        );

        return res.sendStatus(200);
      }

      // ================================
      // GATILHOS
      // ================================

      const ativarBot =
        gatilhos.some(g =>
          textoLower.includes(g)
        );

      // ================================
      // SEM GATILHO
      // ================================

      if (!ativarBot) {

        const agora =
          Date.now();

        const ultimoSaludo =
          cliente.ultimoSaludo || 0;

        const podeEnviarSaludo =
          agora - ultimoSaludo >
          TEMPO_SALUDO;

        if (podeEnviarSaludo) {

          await new Promise(resolve =>
            setTimeout(resolve, 3000)
          );

          const saudacao =

            idioma === "pt"

              ? "Olá 😊\nEm que posso ajudar?"

              : "Hola 😊\n¿En qué puedo ayudarte?";

          await axios.post(

            process.env.ZAPI_URL,

            {
              phone:
                numero,

              message:
                saudacao
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

          cliente.ultimoSaludo =
            agora;

          salvarClientes(
            clientes
          );

          console.log(
            "SALUDO ENVIADO"
          );
        }

        return res.sendStatus(200);
      }

      console.log(
        "BOT ATIVADO"
      );

      // ================================
      // OPENAI
      // ================================

      const respostaWorkflow =
        await axios.post(

          "https://api.openai.com/v1/responses",

          {
            model: "gpt-4o-mini",

            input: `
Cliente:
${cliente.nome}

Idioma:
${cliente.idioma}

Mensagem:
${mensagem}
`
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
        respostaWorkflow.data
        .output_text;

      console.log(
        "RESPOSTA:",
        resposta
      );

      if (!resposta) {

        return res.sendStatus(200);
      }

      // ================================
      // DELAY
      // ================================

      await new Promise(resolve =>
        setTimeout(resolve, 5000)
      );

      // ================================
      // ENVIAR
      // ================================

      await axios.post(

        process.env.ZAPI_URL,

        {
          phone:
            numero,

          message:
            resposta
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
        "RESPOSTA ENVIADA"
      );

      return res.sendStatus(200);

    } catch (error) {

      console.log(

        "ERRO:",

        error.response?.data ||
        error.message
      );

      return res.sendStatus(500);
    }
  }
);

// ======================================
// START
// ======================================

const PORT =
  process.env.PORT || 8080;

app.listen(PORT, () => {

  console.log(
    `Servidor online na porta ${PORT}`
  );
});
```
