require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 8080;

const clientes = {};

const GATILHOS = [

  "remesa",
  "remesas",
  "envio",
  "enviar",
  "mandar",
  "transferencia",
  "transferir",
  "pix",
  "cambio",
  "câmbio",
  "taxa",
  "taxas",
  "real",
  "reales",
  "cup",
  "usd",
  "dolar",
  "dólar",
  "mlc",
  "etecsa",
  "recarga",
  "saldo",
  "cuba",
  "dinero",
  "dinheiro",
  "money",
  "deposito",
  "depósito",
  "receber",
  "recibir"
];

function detectarIdioma(texto) {

  const pt =
    texto.includes("você") ||
    texto.includes("obrigado") ||
    texto.includes("boa") ||
    texto.includes("reais");

  return pt ? "pt" : "es";
}

function saudacao(idioma) {

  if (idioma === "pt") {
    return "Olá 👋 Como posso ajudar?";
  }

  return "Hola 👋 ¿Cómo puedo ayudarte?";
}

function taxaBRL(valor) {

  if (valor < 100) return 100;

  if (valor < 500) return 115;

  return 118;
}

async function enviarMensagem(numero, texto) {

  try {

    await axios.post(

      `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}/send-text`,

      {
        phone: numero,
        message: texto
      },

      {
        headers: {
          "Client-Token": process.env.ZAPI_CLIENT_TOKEN
        }
      }
    );

  } catch (erro) {

    console.log("ERRO ENVIO:");
    console.log(erro.response?.data || erro.message);
  }
}

app.post("/webhook", async (req, res) => {

  try {

    const body = req.body;

    console.log("BODY:");
    console.log(body);

    if (!body?.text?.message) {
      return res.sendStatus(200);
    }

    const numero = body.phone;

    const textoOriginal =
      body.text.message;

    const texto =
      textoOriginal
      .toLowerCase()
      .trim();

    console.log("MENSAGEM:", textoOriginal);

    if (
      body.fromMe ||
      body.isGroup ||
      body.isNewsletter
    ) {
      return res.sendStatus(200);
    }

    if (!clientes[numero]) {

      clientes[numero] = {

        comercial: false,

        modo: "normal",

        ultimaMensagem: "",

        ultimaResposta: "",

        ultimoValor: null,

        ultimoTipo: null
      };
    }

    const idioma =
      detectarIdioma(texto);

    const temGatilho =
      GATILHOS.some(
        palavra =>
          texto.includes(palavra)
      );

    // SAUDAÇÃO NORMAL

    if (
      (
        texto === "hola" ||
        texto === "olá" ||
        texto === "ola" ||
        texto === "boa noite" ||
        texto === "buenas" ||
        texto === "buenas noches"
      ) &&
      !clientes[numero].comercial
    ) {

      const resposta =
        saudacao(idioma);

      await enviarMensagem(
        numero,
        resposta
      );

      return res.sendStatus(200);
    }

    // ATIVA MODO COMERCIAL

    if (temGatilho) {

      clientes[numero]
      .comercial = true;
    }

    // IGNORA CONVERSA NORMAL

    if (
      !clientes[numero]
      .comercial
    ) {
      return res.sendStatus(200);
    }

    // FALAR COM HUMANO

    if (
      texto.includes("yordanys") ||
      texto.includes("humano") ||
      texto.includes("atendente") ||
      texto.includes("persona")
    ) {

      const resposta =
        idioma === "pt"
        ? "Claro 👍 Yordanys continuará com você em instantes."
        : "Claro 👍 Yordanys continuará contigo enseguida.";

      await enviarMensagem(
        numero,
        resposta
      );

      return res.sendStatus(200);
    }

    // DEMORA

    if (
      texto.includes("donde esta") ||
      texto.includes("cadê") ||
      texto.includes("demora")
    ) {

      const resposta =
        idioma === "pt"
        ? "Yordanys responderá assim que estiver disponível 👍"
        : "Yordanys responderá en cuanto esté disponible 👍";

      await enviarMensagem(
        numero,
        resposta
      );

      return res.sendStatus(200);
    }

    // PIX

    if (
      texto.includes("pix")
    ) {

      const resposta =
`8becaaf5-f296-4cbc-a115-46e3d23b042a`;

      await enviarMensagem(
        numero,
        resposta
      );

      return res.sendStatus(200);
    }

    // RECARGA

    if (
      texto.includes("recarga") ||
      texto.includes("saldo") ||
      texto.includes("etecsa")
    ) {

      clientes[numero]
      .modo = "recarga";

      const resposta =
        idioma === "pt"
        ? "Qual valor da recarga em reais?"
        : "¿Cuál es el valor de la recarga en reales?";

      await enviarMensagem(
        numero,
        resposta
      );

      return res.sendStatus(200);
    }

    // REMESA

    if (
      texto.includes("remesa") ||
      texto.includes("envio") ||
      texto.includes("enviar") ||
      texto.includes("cup")
    ) {

      clientes[numero]
      .modo = "remesa";

      const resposta =
        idioma === "pt"
        ? "Quantos reais deseja enviar?"
        : "¿Cuántos reales deseas enviar?";

      await enviarMensagem(
        numero,
        resposta
      );

      return res.sendStatus(200);
    }

    // TAXAS

    if (
      texto.includes("taxa") ||
      texto.includes("taxas") ||
      texto.includes("cambio")
    ) {

      const resposta =
`Menos de 100 reais → 100 CUP
100-499 reais → 115 CUP
500+ reais → 118 CUP`;

      await enviarMensagem(
        numero,
        resposta
      );

      return res.sendStatus(200);
    }

    // VALOR

    const match =
      texto.match(/\d+/);

    const valor =
      match
      ? parseInt(match[0])
      : null;

    // RECARGA CALCULO

    if (
      clientes[numero]
      .modo === "recarga"
    ) {

      if (valor) {

        const saldo =
          valor * 20;

        const resposta =
`${valor} reales = ${saldo.toLocaleString()} CUP de saldo 📲`;

        await enviarMensagem(
          numero,
          resposta
        );

        return res.sendStatus(200);
      }

      if (
        texto.includes("como") ||
        texto.includes("funciona") ||
        texto.includes("explica")
      ) {

        const resposta =
          idioma === "pt"
          ? "A recarga envia saldo ETECSA para internet, SMS e chamadas."
          : "La recarga envía saldo ETECSA para internet, SMS y llamadas.";

        await enviarMensagem(
          numero,
          resposta
        );

        return res.sendStatus(200);
      }
    }

    // REMESA CALCULO

    if (
      clientes[numero]
      .modo === "remesa"
    ) {

      if (valor) {

        const taxa =
          taxaBRL(valor);

        const cup =
          valor * taxa;

        const resposta =
`${valor} reales → ${cup.toLocaleString()} CUP 🔥`;

        await enviarMensagem(
          numero,
          resposta
        );

        return res.sendStatus(200);
      }

      if (
        texto.includes("como") ||
        texto.includes("funciona") ||
        texto.includes("explica")
      ) {

        const resposta =
          idioma === "pt"
          ? "Você envia reais por PIX e a pessoa recebe CUP em Cuba."
          : "Envías reales por PIX y la persona recibe CUP en Cuba.";

        await enviarMensagem(
          numero,
          resposta
        );

        return res.sendStatus(200);
      }
    }

    return res.sendStatus(200);

  } catch (erro) {

    console.log("ERRO GERAL:");
    console.log(erro);

    return res.sendStatus(500);
  }
});

app.listen(PORT, () => {

  console.log(
    `Servidor ONLINE na porta ${PORT}`
  );
});
