const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

/* =========================
   VARIABLES DE ENTORNO
========================= */

const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const ZAPI_INSTANCE     = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN        = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET;

/* =========================
   MEMORIA EN RAM Y BLOQUEOS
========================= */

const pausaHumana   = {}; 
const conversaAtiva = {}; 
const estadoCliente = {}; 
const locks         = {}; 

/* =========================
   CONSTANTES
========================= */

const PAUSA_HUMANA_MS   = 30 * 60 * 1000;
const CONVERSA_ATIVA_MS =  5 * 60 * 1000;
const TTL_ESTADO_RAM    = 24 * 60 * 60 * 1000;

const GATILHOS = [
  "remesa", "remesas", "envio", "enviar", "transferencia", "transferência", 
  "transferir", "cambio", "câmbio", "tasa", "taxa", "tasas", "taxas",
  "real", "reales", "brl", "cup", "usd", "dolar", "dólar", "pix", "mlc",
  "recarga", "saldo", "etecsa", "dinero", "dinheiro", "deposito", "depósito",
  "cartão", "cartao", "habana", "efectivo", "entrega"
];

const SAUDACOES = [
  "hola", "oi", "ola", "olá", "buenas", "bom dia", "boa tarde", "boa noite",
  "buen dia", "buenos dias", "buenas tardes", "buenas noches"
];

const MUNICIPIOS = [
  "habana", "centro habana", "habana vieja", "cerro", "boyeros", "arroyo naranjo", "marianao"
];

const PIX_CHAVE = "8becaaf5-f296-4cbc-a115-46e3d23b042a";
const PIX_NOME  = "YORDANYS RAFAEL SOSA REYES\nNubank";

/* =========================
   UTILIDADES
========================= */

function escapeRegex(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contemPalavra(texto, palabra) {
  const segura = escapeRegex(palabra);
  const regex = new RegExp(`(^|\\s)${segura}(\\s|$)`, "iu");
  return regex.test(texto);
}

/* =========================
   GESTIÓN DE ESTADO Y GC
========================= */

function resetEstado(phone) {
  estadoCliente[phone] = {
    operacion: null, etapa: "inicio", moeda: null, monto: null,
    municipio: null, tarjeta: null, numero: null, aguardando: null,
    pixEnviado: false, ultimoContato: Date.now()
  };
}

function getEstado(phone) {
  if (!estadoCliente[phone]) resetEstado(phone);
  else estadoCliente[phone].ultimoContato = Date.now();
  return estadoCliente[phone];
}

setInterval(() => {
  const agora = Date.now();
  for (const phone in estadoCliente) {
    if (agora - estadoCliente[phone].ultimoContato > TTL_ESTADO_RAM) delete estadoCliente[phone];
  }
  for (const phone in conversaAtiva) if (agora > conversaAtiva[phone]) delete conversaAtiva[phone];
  for (const phone in pausaHumana) if (agora > pausaHumana[phone]) delete pausaHumana[phone];
}, 60 * 60 * 1000);

/* =========================
   APIS EXTERNAS
========================= */

async function enviarMensaje(phone, texto) {
  try {
    await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      { phone, message: texto },
      { 
        headers: { "Client-Token": ZAPI_CLIENT_TOKEN, "Content-Type": "application/json" },
        timeout: 15000 
      }
    );
  } catch (error) {
    console.log("ERRO ZAPI:", error.message);
  }
}

async function responderIA(mensagem, estado) {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Eres YordaBot. Asistente de remesas Cuba-Brasil. Corto (2 líneas), natural, mismo idioma del cliente." },
          { role: "user", content: `CONTEXTO:\n${JSON.stringify(estado)}\n\nCLIENTE:\n${mensagem}` }
        ],
        temperature: 0.4
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, timeout: 25000 }
    );
    return response.data.choices?.[0]?.message?.content?.trim() || "Dime 👍";
  } catch (error) {
    return "Dime 👍";
  }
}

/* =========================
   DETECTORES Y FLUJOS
========================= */

function detectarOperacion(textoLimpo) {
  if (contemPalavra(textoLimpo, "recarga") || contemPalavra(textoLimpo, "etecsa")) return "recarga";
  if (contemPalavra(textoLimpo, "transferencia") || contemPalavra(textoLimpo, "transferência") || contemPalavra(textoLimpo, "transferir")) return "transferencia";
  if (contemPalavra(textoLimpo, "entrega") || contemPalavra(textoLimpo, "habana") || contemPalavra(textoLimpo, "efectivo")) return "entrega";
  return null;
}

async function enviarPix(phone, estado) {
  estado.etapa = "esperando_comprovante";
  estado.pixEnviado = true;
  estado.aguardando = "comprovante";
  await enviarMensaje(phone, PIX_CHAVE);
  await enviarMensaje(phone, PIX_NOME);
}

async function procesarFlujos(phone, estado) {
  if (estado.operacion === "transferencia") {
    if (!estado.monto) { estado.etapa = "esperando_monto"; await enviarMensaje(phone, "¿Cuántos reales deseas enviar?"); return true; }
    if (!estado.tarjeta) { estado.etapa = "esperando_tarjeta"; await enviarMensaje(phone, "Envíame el número de la tarjeta 👌"); return true; }
    if (!estado.pixEnviado) { await enviarPix(phone, estado); return true; }
  }
  if (estado.operacion === "entrega") {
    if (!estado.monto) { estado.etapa = "esperando_monto"; await enviarMensaje(phone, "¿Cuántos reales deseas enviar?"); return true; }
    if (!estado.municipio) { estado.etapa = "esperando_municipio"; await enviarMensaje(phone, "¿A qué municipio de La Habana?"); return true; }
    if (!estado.pixEnviado) { await enviarPix(phone, estado); return true; }
  }
  if (estado.operacion === "recarga") {
    if (!estado.monto) { estado.etapa = "esperando_monto"; await enviarMensaje(phone, "¿De cuánto será la recarga?"); return true; }
    if (!estado.numero) { estado.etapa = "esperando_numero"; await enviarMensaje(phone, "Envíame el número a recargar 👌"); return true; }
    if (!estado.pixEnviado) { await enviarPix(phone, estado); return true; }
  }
  return false;
}

/* =========================
   MIDDLEWARE AUTORIZACIÓN (CORREGIDO)
========================= */

function verificarAutorizacao(req, res, next) {
  const ip = req.ip || "";
  const status = String(req.body.status || "").toUpperCase();

  // Bypass Railway Internal / Local
  if (ip.includes("100.64.") || ip.includes("127.0.0.1") || ip.includes("::1")) return next();

  const queryToken = req.query.token;
  const headerSecret = req.headers["x-webhook-secret"];
  const clientToken = req.headers["client-token"] || req.headers["Client-Token"];

  if (WEBHOOK_SECRET && (queryToken === WEBHOOK_SECRET || headerSecret === WEBHOOK_SECRET)) return next();
  if (ZAPI_CLIENT_TOKEN && clientToken && clientToken.trim() === ZAPI_CLIENT_TOKEN.trim()) return next();

  console.log("AUTORIZAÇÃO NEGADA - IP:", ip);
  return res.sendStatus(401);
}

/* =========================
   WEBHOOK
========================= */

app.post("/webhook", verificarAutorizacao, async (req, res) => {
  const body = req.body;
  const phone = body.phone;
  if (!phone) return res.sendStatus(200);

  if (locks[phone]) {
    await new Promise(r => setTimeout(r, 800));
    if (locks[phone]) return res.sendStatus(200);
  }
  locks[phone] = true;

  try {
    const fromMe = body.fromMe === true || body.fromMe === "true";
    if (body.fromApi === true && fromMe) return res.sendStatus(200);
    if (fromMe) { pausaHumana[phone] = Date.now() + PAUSA_HUMANA_MS; return res.sendStatus(200); }

    const status = String(body.status || "").toUpperCase();
    if (body.isGroup || body.isNewsletter || (status && status !== "RECEIVED")) return res.sendStatus(200);

    const texto = body?.text?.message || "";
    const enviouMidia = !!(body.image || body.video || body.document || body.audio);
    if (!texto && !enviouMidia) return res.sendStatus(200);

    const hora = Number(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }));
    if (hora >= 22 || hora < 6) return res.sendStatus(200);
    if (pausaHumana[phone] && Date.now() < pausaHumana[phone]) return res.sendStatus(200);

    const textoLimpo = texto.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
    if (textoLimpo.includes("yordanys") || textoLimpo.includes("humano") || textoLimpo.includes("operador")) {
      pausaHumana[phone] = Date.now() + PAUSA_HUMANA_MS;
      await enviarMensaje(phone, "Claro 👌 Yordanys te atenderá en breve.");
      return res.sendStatus(200);
    }

    const esComercial = GATILHOS.some(g => contemPalavra(textoLimpo, g));
    if (esComercial) conversaAtiva[phone] = Date.now() + CONVERSA_ATIVA_MS;
    const activa = conversaAtiva[phone] && Date.now() < conversaAtiva[phone];

    if (!esComercial && !activa) {
      if (SAUDACOES.some(s => contemPalavra(textoLimpo, s))) {
        const saludo = hora < 12 ? "Buen día 👋" : hora < 20 ? "Buenas tardes 👋" : "Buenas noches 👋";
        await enviarMensaje(phone, `${saludo} ¿Cómo puedo ayudarte?`);
      }
      return res.sendStatus(200);
    }

    let estado = getEstado(phone);
    const novaOp = detectarOperacion(textoLimpo);
    if (novaOp && novaOp !== estado.operacion) { resetEstado(phone); estado = getEstado(phone); estado.operacion = novaOp; }

    // Detectores
    if (contemPalavra(textoLimpo, "real") || contemPalavra(textoLimpo, "reales") || contemPalavra(textoLimpo, "brl")) estado.moeda = "BRL";
    const matchMonto = texto.match(/\b\d{1,6}([.,]\d{1,2})?\b/);
    if (matchMonto && (estado.etapa === "esperando_monto" || esComercial)) estado.monto = matchMonto[0];
    const soloD = texto.replace(/\D/g, "");
    if (estado.etapa === "esperando_tarjeta" && /^\d{16}$/.test(soloD)) estado.tarjeta = soloD;
    if (estado.etapa === "esperando_numero" && /^\d{8,11}$/.test(soloD)) estado.numero = soloD;
    for (const m of MUNICIPIOS) if (estado.etapa === "esperando_municipio" && textoLimpo.includes(m)) estado.municipio = m;

    if (estado.aguardando === "comprovante" && (enviouMidia || ["pix", "enviado", "comprovante"].some(w => textoLimpo.includes(w)))) {
      await enviarMensaje(phone, "Comprovante recebido 👌 Sua operação será processada.");
      resetEstado(phone); delete conversaAtiva[phone]; return res.sendStatus(200);
    }

    if (estado.operacion && await procesarFlujos(phone, estado)) return res.sendStatus(200);
    if (estado.operacion && estado.pixEnviado) return res.sendStatus(200);

    const respuestaIA = await responderIA(texto, estado);
    await enviarMensaje(phone, respuestaIA);
    res.sendStatus(200);

  } catch (error) {
    if (!res.headersSent) res.sendStatus(500);
  } finally { delete locks[phone]; }
});

app.get("/", (req, res) => res.send("YordaBot ONLINE"));
app.listen(PORT, '0.0.0.0', () => console.log(`Servidor ONLINE puerto ${PORT}`));
