const express = require("express");
const axios = require("axios");

// --- CONFIGURACIÓN GLOBAL ---
axios.defaults.timeout = 25000;

// --- BLINDAJE CONTRA CRASHES ---
process.on("unhandledRejection", (err) => console.log("❌ REJECTION:", err));
process.on("uncaughtException", (err) => console.log("❌ EXCEPTION:", err));

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const PORT = process.env.PORT || 8080;

/* =========================
   VARIABLES DE ENTORNO
========================= */
const { OPENAI_API_KEY, ZAPI_INSTANCE, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, WEBHOOK_SECRET } = process.env;

/* =========================
   MEMORIA VOLÁTIL BLINDADA
========================= */
const pausaHumana = {}, conversaAtiva = {}, estadoCliente = {}, locks = {}, flood = {};

const PAUSA_HUMANA_MS   = 30 * 60 * 1000;
const CONVERSA_ATIVA_MS = 5 * 60 * 1000;
const TTL_ESTADO_RAM    = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS       = 3000; 

// Gatillos limpios y sin duplicados
const GATILHOS = ["remesa", "envio", "enviar", "transferencia", "transferir", "cambio", "tasa", "taxa", "tasas", "taxas", "real", "reales", "brl", "cup", "usd", "dolar", "pix", "mlc", "recarga", "saldo", "etecsa", "dinero", "dinheiro", "deposito", "cartao", "habana", "efectivo", "entrega"];
const SAUDACOES = ["hola", "oi", "ola", "buenas", "bom dia", "boa tarde", "boa noche", "buen dia"];
const IGNORAR_IA = ["ok", "si", "dale", "👍", "gracias", "listo", "entendido", "bueno", "vale"];

const PIX_CHAVE = "8becaaf5-f296-4cbc-a115-46e3d23b042a";
const PIX_NOME  = "YORDANYS RAFAEL SOSA REYES\nNubank";

/* =========================
   MOTOR DE ESTADOS Y LIMPIEZA
========================= */
const escapeRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const contemPalavra = (t, p) => new RegExp(`(^|\\s)${escapeRegex(p)}(\\s|$)`, "iu").test(t);

const resetEstado = (phone) => {
  estadoCliente[phone] = { operacion: null, etapa: "inicio", moeda: null, monto: null, municipio: null, tarjeta: null, numero: null, aguardando: null, pixEnviado: false, ultimoContato: Date.now() };
};

const getEstado = (phone) => {
  if (!estadoCliente[phone]) resetEstado(phone);
  estadoCliente[phone].ultimoContato = Date.now();
  return estadoCliente[phone];
};

// Garbage Collector Pro
setInterval(() => {
  const agora = Date.now();
  Object.keys(estadoCliente).forEach(p => { if (agora - estadoCliente[p].ultimoContato > TTL_ESTADO_RAM) delete estadoCliente[p]; });
  Object.keys(conversaAtiva).forEach(p => { if (agora > conversaAtiva[p]) delete conversaAtiva[p]; });
  Object.keys(pausaHumana).forEach(p => { if (agora > pausaHumana[p]) delete pausaHumana[p]; });
  Object.keys(flood).forEach(p => { if (agora - flood[p] > 60000) delete flood[p]; }); 
  Object.keys(locks).forEach(p => { if (agora - locks[p] > 30000) delete locks[p]; });
}, 60 * 1000);

/* =========================
   MENSAJERÍA E IA
========================= */
async function enviarMensaje(phone, message) {
  try {
    await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, { phone, message }, { headers: { "Client-Token": ZAPI_CLIENT_TOKEN } });
  } catch (e) { console.error("❌ ERROR Z-API:", e.message); }
}

async function responderIA(mensagem, estado) {
  try {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Eres YordaBot. Asistente de remesas. Corto y natural." },
        { role: "user", content: `ESTADO: ${JSON.stringify(estado)}\nMSJ: ${mensagem}` }
      ],
      temperature: 0.3
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    return res.data.choices?.[0]?.message?.content?.trim() || "Dime 👍";
  } catch (e) { return "Dime 👍"; }
}

/* =========================
   MIDDLEWARE DE SEGURIDAD (Fix #2)
========================= */
const verificarSecret = (req, res, next) => {
  if (!WEBHOOK_SECRET) return next();
  const token = req.query.token || req.headers["x-webhook-secret"];
  if (token === WEBHOOK_SECRET) return next();
  console.log("⚠️ Intento de acceso no autorizado bloqueado.");
  return res.sendStatus(401);
};

/* =========================
   WEBHOOK PRINCIPAL
========================= */
app.post("/webhook", verificarSecret, async (req, res) => {
  const body = req.body;
  const phone = body.phone;
  if (!phone) return res.sendStatus(200);

  if (flood[phone] && (Date.now() - flood[phone] < 1200)) return res.sendStatus(200);
  flood[phone] = Date.now();

  const isGroup = body.isGroup === true || body.isGroup === "true";
  const status = String(body.status || "").toUpperCase();
  const fromMe = body.fromMe === true || body.fromMe === "true";

  if (isGroup || fromMe || String(phone).includes("-group") || String(phone).includes("@lid") || (status && status !== "RECEIVED")) {
    return res.sendStatus(200);
  }

  if (locks[phone] && (Date.now() - locks[phone] < LOCK_TTL_MS)) return res.sendStatus(200);
  locks[phone] = Date.now();

  try {
    const textoOriginal = String(body?.text?.message || "");
    const textoLimpo = textoOriginal
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .trim();

    const tipoZAPI = String(body.type || "").toLowerCase();
    const tieneMedia = !!(
      body.image || body.video || body.audio || body.document ||
      tipoZAPI.includes("image") || tipoZAPI.includes("video") || 
      tipoZAPI.includes("audio") || tipoZAPI.includes("document")
    );

    if (pausaHumana[phone] && Date.now() < pausaHumana[phone]) return res.sendStatus(200);
    if (!textoOriginal && !tieneMedia) return res.sendStatus(200);

    if (conversaAtiva[phone] && Date.now() > conversaAtiva[phone]) {
      delete conversaAtiva[phone];
      resetEstado(phone);
    }

    const esComercial = GATILHOS.some(g => contemPalavra(textoLimpo, g));
    if (esComercial) conversaAtiva[phone] = Date.now() + CONVERSA_ATIVA_MS;

    if (!esComercial && !(conversaAtiva[phone] && Date.now() < conversaAtiva[phone])) {
      if (SAUDACOES.some(s => contemPalavra(textoLimpo, s))) {
        await enviarMensaje(phone, "Hola 👋 ¿Cómo puedo ayudarte?");
      }
      return res.sendStatus(200);
    }

    let estado = getEstado(phone);
    if (contemPalavra(textoLimpo, "recarga")) estado.operacion = "recarga";

    const matchMonto = textoOriginal.match(/\b\d{1,6}([.,]\d{1,2})?\b/);
    if (matchMonto && (estado.etapa === "esperando_monto" || ["real", "reales", "cup", "usd", "brl"].some(m => textoLimpo.includes(m)))) {
      estado.monto = matchMonto[0];
    }

    const soloD = textoOriginal.replace(/\D/g, "");
    if (estado.etapa === "esperando_tarjeta" && /^\d{16}$/.test(soloD)) estado.tarjeta = soloD;
    if (estado.etapa === "esperando_numero" && /^\d{8,11}$/.test(soloD)) estado.numero = soloD;

    if (estado.aguardando === "comprovante" && tieneMedia) {
      await enviarMensaje(phone, "Comprobante recibido 👌 Procesaremos tu operación en breve.");
      resetEstado(phone);
      delete conversaAtiva[phone];
      return res.sendStatus(200);
    }

    if (estado.operacion === "recarga") {
      if (!estado.monto) {
        estado.etapa = "esperando_monto";
        await enviarMensaje(phone, "¿De cuánto quieres la recarga?");
        return res.sendStatus(200);
      }
      if (!estado.numero) {
        estado.etapa = "esperando_numero";
        await enviarMensaje(phone, "Dime el número a recargar 👌");
        return res.sendStatus(200);
      }
      if (!estado.pixEnviado) {
        estado.pixEnviado = true;
        estado.aguardando = "comprovante";
        await enviarMensaje(phone, `*Llave PIX:* \n${PIX_CHAVE}\n\n*Beneficiario:* \n${PIX_NOME}`);
        return res.sendStatus(200);
      }
    }

    if (estado.pixEnviado || IGNORAR_IA.includes(textoLimpo)) return res.sendStatus(200);

    const respuestaIA = await responderIA(textoOriginal, estado);
    await enviarMensaje(phone, respuestaIA);
    res.sendStatus(200);

  } catch (error) {
    // Catch con log real (Fix #3)
    console.error("❌ WEBHOOK ERROR:", error.message);
    if (!res.headersSent) res.sendStatus(500);
  } finally {
    delete locks[phone];
  }
});

app.get("/", (req, res) => res.send("YordaBot ONLINE: Edición Industrial Final"));

const server = app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Microservicio serio en puerto ${PORT}`));
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
