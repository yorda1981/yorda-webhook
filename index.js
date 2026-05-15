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
  !fs.existsSync(ARQUIVO_CLIENTES)
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

function salvarClientes(clientes) {

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
// CIDADES
// ======================================

const cidades = [

  "habana",
  "santiago",
  "camagüey",
  "holguin",
  "bayamo",
  "matanzas",
  "villa clara"
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

app.post("/webhook", async (req, res) => {

  try {

    console.log(req.body);

    // ==================================
    // IGNORAR GRUPOS
    // ==================================

    if (req.body.isGroup) {

      console.log(
        "GRUPO IGNORADO"
      );

      return res.sendStatus(200);
    }

    // ==================================
    // IGNORAR NEWSLETTER
    // ==================================

    if (req.body.isNewsletter) {

      console.log(
        "NEWSLETTER IGNORADA"
      );

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

    // ==================================
    // TEXTO
    // ==================================

    const textoLower =
      mensagem
        .toLowerCase()
        .trim();

    console.log(
      "MENSAGEM:",
      textoLower
    );

    // ==================================
    // DETECTAR IDIOMA
    // ==================================

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

    // ==================================
    // DETECTAR MIDIA
    // ==================================

    const temImagem =
      req.body.image;

    const imagemUrl =
      req.body.image?.imageUrl || null;

    const temDocumento =
      req.body.document;

    const temMidia =
      temImagem || temDocumento;

    console.log(
      "TEM MIDIA:",
      temMidia
    );

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

    // ==================================
    // CLIENTES
    // ==================================

    let clientes =
      lerClientes();

    let cliente =
      clientes.find(
        c => c.numero === numero
      );

    // ==================================
    // NOVO CLIENTE
    // ==================================

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

        ultimoSaludo: 0,

        tipoOperacao:
          null,

        ultimaCidade:
          null,

        ultimoMonto:
          null,

        ultimaMoeda:
          null,

        ultimoComprovante:
          null
      };

      clientes.push(cliente);

      console.log(
        "NOVO CLIENTE"
      );
    }

    // ==================================
    // CLIENTE EXISTENTE
    // ==================================

    else {

      cliente.nome =
        nomeWhatsapp;

      cliente.idioma =
        idioma;

      cliente.ultimaMensagem =
        mensagem;

      cliente.ultimoContato =
        new Date()
          .toISOString();

      console.log(
        "CLIENTE EXISTENTE"
      );
    }

    // ==================================
    // DETECTAR OPERAÇÃO
    // ==================================

    let tipoOperacao =
      null;

    if (
      textoLower.includes(
        "recarga"
      )
    ) {

      tipoOperacao =
        "recarga";
    }

    else if (

      textoLower.includes(
        "usd"
      ) ||

      textoLower.includes(
        "dolar"
      ) ||

      textoLower.includes(
        "dólar"
      )

    ) {

      tipoOperacao =
        "usd";
    }

    else if (

      textoLower.includes(
        "real"
      ) ||

      textoLower.includes(
        "reales"
      ) ||

      textoLower.includes(
        "cup"
      )

    ) {

      tipoOperacao =
        "remesa";
    }

    if (tipoOperacao) {

      cliente.tipoOperacao =
        tipoOperacao;
    }

    // ==================================
    // DETECTAR CIDADE
    // ==================================

    const cidadeDetectada =
      cidades.find(c =>
        textoLower.includes(c)
      );

    if (cidadeDetectada) {

      cliente.ultimaCidade =
        cidadeDetectada;
    }

    // ==================================
    // DETECTAR MONTOS
    // ==================================

    const numeros =
      textoLower.match(/\d+/g);

    let montoDetectado =
      null;

    if (
      numeros &&
      numeros.length > 0
    ) {

      montoDetectado =
        parseInt(numeros[0]);
    }

    if (montoDetectado) {

      cliente.ultimoMonto =
        montoDetectado;
    }

    // ==================================
    // DETECTAR MOEDA
    // ==================================

    let moedaDetectada =
      null;

    if (

      textoLower.includes(
        "real"
      ) ||

      textoLower.includes(
        "reales"
      ) ||

      textoLower.includes(
        "brl"
      )

    ) {

      moedaDetectada =
        "BRL";
    }

    else if (

      textoLower.includes(
        "usd"
      ) ||

      textoLower.includes(
        "dolar"
      ) ||

      textoLower.includes(
        "dólar"
      )

    ) {

      moedaDetectada =
        "USD";
    }

    else if (

      textoLower.includes(
        "mlc"
      )

    ) {

      moedaDetectada =
        "MLC";
    }

    if (moedaDetectada) {

      cliente.ultimaMoeda =
        moedaDetectada;
    }

    // ==================================
    // OCR COMPROVANTE
    // ==================================

    if (temMidia) {

      let respostaMidia =
        idioma === "pt"

          ? "Comprovante recebido ✅\nEstou verificando o pagamento."

          : "Comprobante recibido ✅\nEstoy verificando el pago.";

      let dadosComprovante =
        null;

      try {

        if (imagemUrl) {

          const analiseImagem =
            await axios.post(

              "https://api.openai.com/v1/chat/completions",

              {
                model:
                  "gpt-4o-mini",

                messages: [

                  {
                    role:
                      "system",

                    content:
                      "Extraia apenas banco, valor, nome e tipo pix do comprovante. Responda em JSON válido."
                  },

                  {
                    role:
                      "user",

                    content: [

                      {
                        type:
                          "text",

                        text:
                          "Leia este comprovante PIX"
                      },

                      {
                        type:
                          "image_url",

                        image_url: {
                          url:
                            imagemUrl
                        }
                      }
                    ]
                  }
                ],

                temperature: 0
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

          dadosComprovante =
            analiseImagem.data
            .choices[0]
            .message.content;

          console.log(
            "OCR:",
            dadosComprovante
          );
        }

      } catch (erroOCR) {

        console.log(
          "ERRO OCR:",
          erroOCR.message
        );
      }

      if (dadosComprovante) {

        cliente.ultimoComprovante =
          dadosComprovante;
      }

      salvarClientes(
        clientes
      );

      // ================================
      // DELAY HUMANO
      // ================================

      await new Promise(resolve =>
        setTimeout(resolve, 3000)
      );

      // ================================
      // CANCELAR
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
            "OCR CANCELADO"
          );

          return res.sendStatus(200);
        }
      }

      await axios.post(

        process.env.ZAPI_URL,

        {
          phone:
            numero,

          message:
            respostaMidia
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

    // ==================================
    // GATILHOS
    // ==================================

    const ativarBot =
      gatilhos.some(g =>
        textoLower.includes(g)
      );

    // ==================================
    // SEM GATILHO
    // ==================================

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

        if (pausados[numero]) {

          const tempoPassado =
            Date.now() -
            pausados[numero];

          if (
            tempoPassado <
            TEMPO_PAUSA
          ) {

            console.log(
              "SALUDO CANCELADO"
            );

            return res.sendStatus(200);
          }
        }

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

    // ==================================
    // MEMÓRIA GPT
    // ==================================

    const memoriaCliente = `
Cliente:
${cliente.nome}

Idioma:
${cliente.idioma}

Tipo Operação:
${cliente.tipoOperacao || "não informado"}

Última Cidade:
${cliente.ultimaCidade || "não informada"}

Último Valor:
${cliente.ultimoMonto || "não informado"}

Última Moeda:
${cliente.ultimaMoeda || "não informada"}

Último Comprovante:
${cliente.ultimoComprovante || "não enviado"}

Última Mensagem:
${cliente.ultimaMensagem}
`;

    console.log(
      "BOT ATIVADO"
    );

    // ==================================
    // OPENAI
    // ==================================

    const respostaWorkflow =
      await axios.post(

        "https://api.openai.com/v1/responses",

        {
          model:
            "gpt-4o-mini",

          workflow: {
            id:
              process.env.WORKFLOW_ID
          },

          input: `
${memoriaCliente}

Mensagem atual:
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

    // ==================================
    // DELAY HUMANO
    // ==================================

    await new Promise(resolve =>
      setTimeout(resolve, 5000)
    );

    // ==================================
    // CANCELAR ENVIO
    // ==================================

    if (pausados[numero]) {

      const tempoPassado =
        Date.now() -
        pausados[numero];

      if (
        tempoPassado <
        TEMPO_PAUSA
      ) {

        console.log(
          "ENVIO CANCELADO"
        );

        return res.sendStatus(200);
      }
    }

    // ==================================
    // ENVIAR RESPOSTA
    // ==================================

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

    salvarClientes(
      clientes
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
});

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
