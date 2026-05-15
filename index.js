const express = require("express");
const axios = require("axios");
const fs = require("fs");

const app = express();

app.use(express.json());

// ======================================
// MEMÓRIA CLIENTES
// ======================================

const ARQUIVO_CLIENTES =
  "./clientes.json";

// CRIAR JSON SE NÃO EXISTIR

if (
  !fs.existsSync(ARQUIVO_CLIENTES)
) {

  fs.writeFileSync(
    ARQUIVO_CLIENTES,
    "[]"
  );
}

// LER CLIENTES

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

// SALVAR CLIENTES

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
// PAUSA HUMANA
// ======================================

const pausados = {};

const TEMPO_PAUSA =
  30 * 60 * 1000;

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

    const mensagem =
      req.body.text?.message || "";

    const numero =
      req.body.phone || "";

    const nomeWhatsapp =
      req.body.senderName ||
      "Cliente";

    if (!mensagem || !numero) {

      return res.sendStatus(200);
    }

    // ==================================
    // TEXTO
    // ==================================

    const textoLower =
      mensagem.toLowerCase().trim();

    console.log(
      "MENSAGEM:",
      textoLower
    );

    // ==================================
    // DETECTAR OPERAÇÃO
    // ==================================

    let tipoOperacao = null;

    if (
      textoLower.includes("recarga")
    ) {

      tipoOperacao =
        "recarga";
    }

    else if (

      textoLower.includes("usd") ||
      textoLower.includes("dolar") ||
      textoLower.includes("dólar")

    ) {

      tipoOperacao =
        "usd";
    }

    else if (

      textoLower.includes("real") ||
      textoLower.includes("reales") ||
      textoLower.includes("cup")

    ) {

      tipoOperacao =
        "remesa";
    }

    // ==================================
    // DETECTAR CIDADES
    // ==================================

    const cidades = [

      "habana",
      "santiago",
      "camagüey",
      "holguin",
      "bayamo",
      "matanzas",
      "villa clara"
    ];

    const cidadeDetectada =
      cidades.find(c =>
        textoLower.includes(c)
      );

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

    let moedaDetectada =
      null;

    if (

      textoLower.includes("real") ||
      textoLower.includes("reales") ||
      textoLower.includes("brl")

    ) {

      moedaDetectada =
        "BRL";
    }

    else if (

      textoLower.includes("usd") ||
      textoLower.includes("dolar") ||
      textoLower.includes("dólar")

    ) {

      moedaDetectada =
        "USD";
    }

    else if (
      textoLower.includes("mlc")
    ) {

      moedaDetectada =
        "MLC";
    }

    console.log(
      "TIPO:",
      tipoOperacao
    );

    console.log(
      "CIDADE:",
      cidadeDetectada
    );

    console.log(
      "MONTO:",
      montoDetectado
    );

    console.log(
      "MOEDA:",
      moedaDetectada
    );

    // ==================================
    // YORDANYS RESPONDE
    // ==================================

    if (req.body.fromMe) {

      const mensagensIgnorar = [
        "si",
        "sí",
        "ok",
        "👍",
        "ya",
        "listo"
      ];

      const pausar =
        !mensagensIgnorar.includes(
          textoLower
        );

      if (pausar) {

        pausados[numero] =
          Date.now();

        console.log(
          "BOT PAUSADO:",
          numero
        );
      }

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
    // MEMÓRIA CLIENTE
    // ==================================

    let clientes =
      lerClientes();

    let cliente =
      clientes.find(
        c => c.numero === numero
      );

    // NOVO CLIENTE

    if (!cliente) {

      cliente = {

        numero,
        nome: nomeWhatsapp,
        ultimaMensagem:
          mensagem,
        ultimoContato:
          new Date()
            .toISOString(),

        saludoEnviado: false
      };

      clientes.push(cliente);

      console.log(
        "NOVO CLIENTE:",
        nomeWhatsapp
      );
    }

    // CLIENTE EXISTENTE

    else {

      cliente.nome =
        nomeWhatsapp;

      cliente.ultimaMensagem =
        mensagem;

      cliente.ultimoContato =
        new Date()
          .toISOString();

      console.log(
        "CLIENTE EXISTENTE:",
        nomeWhatsapp
      );
    }

    // ==================================
    // GUARDAR DADOS EXTRAS
    // ==================================

    if (tipoOperacao) {

      cliente.tipoOperacao =
        tipoOperacao;
    }

    if (cidadeDetectada) {

      cliente.ultimaCidade =
        cidadeDetectada;
    }

    if (montoDetectado) {

      cliente.ultimoMonto =
        montoDetectado;
    }

    if (moedaDetectada) {

      cliente.ultimaMoeda =
        moedaDetectada;
    }

    salvarClientes(clientes);

    // ==================================
    // GATILHOS
    // ==================================

    const ativarBot =
      gatilhos.some(g =>
        textoLower.includes(g)
      );

    // ==================================
    // CLIENTE SEM GATILHO
    // ==================================

    if (!ativarBot) {

      if (!cliente.saludoEnviado) {

        await axios.post(

          process.env.ZAPI_URL,

          {
            phone: numero,

            message:
              "Hola 😊\n¿En qué puedo ayudarte?"
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

        cliente.saludoEnviado =
          true;

        salvarClientes(clientes);

        console.log(
          "SALUDO ENVIADO"
        );
      }

      return res.sendStatus(200);
    }

    console.log(
      "BOT ATIVADO"
    );

    // ==================================
    // CONTEXTO MEMÓRIA
    // ==================================

    const memoriaCliente = `
Cliente:
${cliente.nome}

Tipo de operação:
${cliente.tipoOperacao || "não informado"}

Última cidade:
${cliente.ultimaCidade || "não informada"}

Último monto:
${cliente.ultimoMonto || "não informado"}

Última moeda:
${cliente.ultimaMoeda || "não informada"}

Última mensagem:
${cliente.ultimaMensagem}

Último contato:
${cliente.ultimoContato}
`;

    // ==================================
    // OPENAI WORKFLOW
    // ==================================

    const respostaWorkflow =
      await axios.post(

        "https://api.openai.com/v1/responses",

        {
          model: "gpt-4o-mini",

          workflow: {
            id: process.env.WORKFLOW_ID
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

    // ==================================
    // RESPOSTA
    // ==================================

    const resposta =
      respostaWorkflow.data
      .output_text;

    console.log(
      "RESPOSTA:",
      resposta
    );

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

    console.log(
      "MENSAGEM ENVIADA"
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
