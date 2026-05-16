const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 8080;

/* =========================
   VARIABLES
========================= */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/* =========================
   MEMÓRIAS
========================= */

const pausaHumana = {};
const conversaAtiva = {};
const estadoCliente = {};

/* =========================
   GATILHOS
========================= */

const gatilhos = [
  "remesa", "remesas", "envio", "enviar",
  "transferencia", "transferência", "transferir",
  "cambio", "câmbio", "tasa", "taxa", "tasas", "taxas",
  "real", "reales", "brl", "cup", "usd",
  "dolar", "dólar", "pix", "mlc",
  "recarga", "saldo", "etecsa",
  "dinero", "dinheiro",
  "deposito", "depósito",
  "cartão", "cartao",
  "habana", "efectivo", "entrega"
];

/* =========================
   SAUDAÇÕES
========================= */

const saudacoes = [
  "hola", "oi", "ola", "olá", "buenas",
  "bom dia", "boa tarde", "boa noite",
  "buen dia", "buenos dias",
  "buenas tardes", "buenas noches"
];

/* =========================
   ENVIAR WHATSAPP
========================= */

async function enviarMensaje(phone, texto) {
  try {
    const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;

    const response = await axios.post(
      url,
      { phone: phone, message: texto },
      {
        headers: {
          "Client-Token": ZAPI_CLIENT_TOKEN,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("ENVIADO:", response.data);

  } catch (error) {
    console.log("ERRO ZAPI:");
    console.log(error.response?.data || error.message);
  }
}

/* =========================
   OPENAI (Endpoint, Estructura y Modelo Corregidos)
========================= */

async function responderIA(mensagem, contexto = "") {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini", // El modelo ideal, rápido y económico para este tipo de bots
        messages: [
          {
            role: "system",
            content: `Eres YordaBot. Asistente humano de remesas.

REGLAS:
- Responder corto.
- Máximo 2 líneas.
- Sonar natural.
- No sonar como IA.
- No usar listas largas.
- No explicar demasiado.
- Hablar en idioma del cliente.

Operaciones:
- transferencia
- entrega
- recarga

No repetir preguntas.
No pedir datos ya informados.`
          },
          {
            role: "user",
            content: `CONTEXTO ACTUAL DEL CLIENTE:\n${contexto}\n\nMENSAGEM DEL CLIENTE:\n${mensagem}`
          }
        ],
        temperature: 0.5
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const texto = response.data.choices?.[0]?.message?.content;
    return texto ? texto.trim() : "Dime 👍";

  } catch (error) {
    console.log("ERRO OPENAI:");
    console.log(error.response?.data || error.message);
    return "Dime 👍";
  }
}

/* =========================
   RESET ESTADO
========================= */

function resetEstado(phone) {
  estadoCliente[phone] = {
    operacion: null,
    etapa: "inicio",
    moeda: null,
    monto: null,
    municipio: null,
    tarjeta: null,
    numero: null,
    aguardando: null,
    pixEnviado: false
  };
}

/* =========================
   MIDDLEWARE AUTORIZAÇÃO
========================= */

function verificarAutorizacao(req, res, next) {
  const headerSecret = req.headers["x-webhook-secret"];
  if (WEBHOOK_SECRET && headerSecret === WEBHOOK_SECRET) {
    return next();
  }

  const queryToken = req.query.token;
  if (WEBHOOK_SECRET && queryToken === WEBHOOK_SECRET) {
    return next();
  }

  const clientToken = req.headers["client-token"];
  if (ZAPI_CLIENT_TOKEN && clientToken === ZAPI_CLIENT_TOKEN) {
    return next();
  }

  console.log("AUTORIZAÇÃO NEGADA - IP:", req.ip);
  return res.sendStatus(401);
}

/* =========================
   WEBHOOK
========================= */

app.post("/webhook", verificarAutorizacao, async (req, res) => {
  try {
    const body = req.body;

    // Validación preventiva en caso de que llegue un payload vacío o corrupto
    if (!body) {
      return res.sendStatus(200);
    }

    if (
      body.isGroup === true ||
      body.isNewsletter === true ||
      body.isEdit === true ||
      body.fromApi === true ||
      body.status !== "RECEIVED"
    ) {
      return res.sendStatus(200);
    }

    const texto = body?.text?.message || "";
    const phone = body.phone;

    if (!texto || !phone) {
      return res.sendStatus(200);
    }

    const hora = new Date().getHours();

    if (hora >= 22 || hora < 6) {
      console.log("HORÁRIO DE DESCANSO");
      return res.sendStatus(200);
    }

    /* =========================
       PAUSA HUMANA
    ========================== */

    if (body.fromMe === true) {
      pausaHumana[phone] = Date.now() + (30 * 60 * 1000);
      console.log("PAUSA HUMANA:", phone);
      return res.sendStatus(200);
    }

    if (pausaHumana[phone] && Date.now() < pausaHumana[phone]) {
      console.log("BOT PAUSADO:", phone);
      return res.sendStatus(200);
    }

    console.log("MENSAGEM:", texto);

    const textoLimpo = texto
      .toLowerCase()
      .replace(/[^\w\s]/gi, " ");

    /* =========================
       PEDIR HUMANO
    ========================== */

    if (
      textoLimpo.includes("yordanys") ||
      textoLimpo.includes("humano") ||
      textoLimpo.includes("operador")
    ) {
      pausaHumana[phone] = Date.now() + (30 * 60 * 1000);
      await enviarMensaje(phone, "Claro 👌 Yordanys continuará tu atención en breve.");
      return res.sendStatus(200);
    }

    /* =========================
       GATILHOS
    ========================== */

    const comercial = gatilhos.some(g => textoLimpo.includes(g));

    if (comercial) {
      conversaAtiva[phone] = Date.now() + (5 * 60 * 1000);
    }

    const conversaEmAndamento =
      conversaAtiva[phone] &&
      Date.now() < conversaAtiva[phone];

    /* =========================
       LIMPAR CONTEXTO VELHO
    ========================== */

    if (conversaAtiva[phone] && Date.now() > conversaAtiva[phone]) {
      delete conversaAtiva[phone];
      resetEstado(phone);
    }

    /* =========================
       SAUDAÇÃO
    ========================== */

    const saudacao = saudacoes.some(s => textoLimpo.includes(s));

    if (saudacao && !comercial && !conversaEmAndamento) {
      let saludo = "";

      if (hora >= 6 && hora < 12) {
        saludo = "Buen día 👋 ¿Cómo puedo ayudarte hoy?";
      } else if (hora >= 12 && hora < 20) {
        saludo = "Buenas tardes 👋 ¿Cómo puedo ayudarte hoy?";
      } else {
        saludo = "Buenas noches 👋 ¿Cómo puedo ayudarte hoy?";
      }

      await enviarMensaje(phone, saludo);
      return res.sendStatus(200);
    }

    if (!comercial && !conversaEmAndamento) {
      console.log("SEM INTENÇÃO COMERCIAL");
      return res.sendStatus(200);
    }

    if (!estadoCliente[phone]) {
      resetEstado(phone);
    }

    let estado = estadoCliente[phone];

    /* =========================
       DETECTAR OPERAÇÃO
    ========================== */

    let novaOperacao = null;

    if (
      textoLimpo.includes("entrega") ||
      textoLimpo.includes("habana") ||
      textoLimpo.includes("efectivo")
    ) {
      novaOperacao = "entrega";
    }

    if (
      textoLimpo.includes("transferencia") ||
      textoLimpo.includes("transferir")
    ) {
      novaOperacao = "transferencia";
    }

    if (
      textoLimpo.includes("recarga") ||
      textoLimpo.includes("etecsa")
    ) {
      novaOperacao = "recarga";
    }

    if (novaOperacao && estado.operacion !== novaOperacao) {
      resetEstado(phone);
      estadoCliente[phone].operacion = novaOperacao;
      estado = estadoCliente[phone]; 
    }

    /* =========================
       DETECTAR MOEDA
    ========================== */

    if (
      textoLimpo.includes("real") ||
      textoLimpo.includes("reales") ||
      textoLimpo.includes("brl")
    ) {
      estado.moeda = "BRL";
    }

    if (
      textoLimpo.includes("usd") ||
      textoLimpo.includes("dolar") ||
      textoLimpo.includes("dólar")
    ) {
      estado.moeda = "USD";
    }

    /* =========================
       DETECTAR MONTO
    ========================== */

    const numero = texto.match(/\d+([.,]\d+)?/);
    if (
      numero &&
      (
        estado.etapa === "esperando_monto" ||
        textoLimpo.includes("real") ||
        textoLimpo.includes("reales") ||
        textoLimpo.includes("usd") ||
        textoLimpo.includes("cup")
      )
    ) {
      estado.monto = numero[0];
    }

    /* =========================
       DETECTAR TARJETA
    ========================== */

    const tarjeta = texto.replace(/\D/g, "");
    if (/^\d{16}$/.test(tarjeta)) { 
      estado.tarjeta = tarjeta;
    }

    /* =========================
       MUNICIPIOS
    ========================== */

    const municipios = [
      "habana", "centro habana", "habana vieja",
      "cerro", "boyeros", "arroyo naranjo", "marianao"
    ];

    municipios.forEach(m => {
      if (
        estado.etapa === "esperando_municipio" &&
        textoLimpo.includes(m)
      ) {
        estado.municipio = m;
      }
    });

    /* =========================
       RECARGA
    ========================== */

    if (estado.operacion === "recarga") {
      const numeroRecarga = texto.replace(/\D/g, "");
      if (
        estado.etapa === "esperando_numero" &&
        numeroRecarga.length >= 8 &&
        numeroRecarga.length <= 12
      ) {
        estado.numero = numeroRecarga;
      }
    }

    /* =========================
       FLUJOS
    ========================== */

    if (estado.operacion === "transferencia") {
      if (!estado.monto) {
        estado.etapa = "esperando_monto";
        await enviarMensaje(phone, "¿Cuántos reales deseas enviar?");
        return res.sendStatus(200);
      }

      if (!estado.tarjeta) {
        estado.etapa = "esperando_tarjeta";
        await enviarMensaje(phone, "Envíame la tarjeta 👌");
        return res.sendStatus(200);
      }

      if (!estado.pixEnviado) {
        estado.etapa = "esperando_comprovante";
        estado.pixEnviado = true;
        estado.aguardando = "comprovante";
        await enviarMensaje(phone, "8becaaf5-f296-4cbc-a115-46e3d23b042a");
        await enviarMensaje(phone, "YORDANYS RAFAEL SOSA REYES\nNubank");
        return res.sendStatus(200);
      }
    }

    if (estado.operacion === "entrega") {
      if (!estado.monto) {
        estado.etapa = "esperando_monto";
        await enviarMensaje(phone, "¿Cuántos reales deseas enviar?");
        return res.sendStatus(200);
      }

      if (!estado.municipio) {
        estado.etapa = "esperando_municipio";
        await enviarMensaje(phone, "¿Cuál municipio de La Habana?");
        return res.sendStatus(200);
      }

      if (!estado.pixEnviado) {
        estado.etapa = "esperando_comprovante";
        estado.pixEnviado = true;
        estado.aguardando = "comprovante";
        await enviarMensaje(phone, "8becaaf5-f296-4cbc-a115-46e3d23b042a");
        await enviarMensaje(phone, "YORDANYS RAFAEL SOSA REYES\nNubank");
        return res.sendStatus(200);
      }
    }

    if (estado.operacion === "recarga") {
      if (!estado.monto) {
        estado.etapa = "esperando_monto";
        await enviarMensaje(phone, "¿De cuánto será la recarga?");
        return res.sendStatus(200);
      }

      if (!estado.numero) {
        estado.etapa = "esperando_numero";
        await enviarMensaje(phone, "Envíame el número 👌");
        return res.sendStatus(200);
      }

      if (!estado.pixEnviado) {
        estado.etapa = "esperando_comprovante";
        estado.pixEnviado = true;
        estado.aguardando = "comprovante";
        await enviarMensaje(phone, "8becaaf5-f296-4cbc-a115-46e3d23b042a");
        await enviarMensaje(phone, "YORDANYS RAFAEL SOSA REYES\nNubank");
        return res.sendStatus(200);
      }
    }

    /* =========================
       COMPROVANTE
    ========================== */

    if (
      estado.aguardando === "comprovante" &&
      (
        body.image ||
        textoLimpo.includes("pix") ||
        textoLimpo.includes("enviado") ||
        textoLimpo.includes("comprovante")
      )
    ) {
      await enviarMensaje(phone, "Comprovante recebido 👌");
      await enviarMensaje(phone, "Sua operação será processada.");

      resetEstado(phone);
      delete conversaAtiva[phone];

      return res.sendStatus(200);
    }

    /* =========================
       EVITAR OPENAI LOUCO
    ========================== */

    if (conversaEmAndamento && !estado.operacion) {
      return res.sendStatus(200);
    }

    if (
      estado.operacion &&
      estado.etapa !== "inicio"
    ) {
      return res.sendStatus(200);
    }

    /* =========================
       OPENAI FALLBACK
    ========================== */

    const contexto = JSON.stringify(estado, null, 2);
    const respostaIA = await responderIA(texto, contexto);

    await enviarMensaje(phone, respostaIA);
    return res.sendStatus(200);

  } catch (error) {
    console.log("ERRO GERAL:");
    console.log(error.response?.data || error.message);
    
    // Evita crash de cabeceras si Express ya había enviado una respuesta parcial previa
    if (!res.headersSent) {
      return res.sendStatus(500);
    }
  }
});

/* =========================
   ONLINE
========================= */

app.get("/", (req, res) => {
  res.send("YordaBot ONLINE");
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log("Servidor ONLINE na porta " + PORT);
});
