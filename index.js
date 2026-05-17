const express = require("express");
const axios = require("axios");

// --- CONFIGURACIÓN GLOBAL ---
axios.defaults.timeout = 20000;

// --- PROTECCIÓN CONTRA CRASHES ---
process.on("unhandledRejection", (err) => console.log("❌ UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err) => console.log("❌ UNCAUGHT EXCEPTION:", err));

const app = express();
app.disable("x-powered-by"); 
app.set("trust proxy", true); 

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

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
   MEMORIA EN RAM
========================= */
const pausaHumana   = {}; 
const conversaAtiva = {}; 
const estadoCliente = {}; 
const locks         = {}; 
const flood         = {}; // Rate limit anti-spam

const PAUSA_HUMANA_MS   = 30 * 60 * 1000;
const CONVERSA_ATIVA_MS =  5 * 60 * 1000;
const TTL_ESTADO_RAM    = 24 * 60 * 60 * 1000;

const GATILHOS = ["remesa", "remesas", "envio", "enviar", "transferencia", "transferência", "transferir", "cambio", "câmbio", "tasa", "taxa", "tasas", "taxas", "real", "reales", "brl", "cup", "usd", "dolar", "dólar", "pix", "mlc", "recarga", "saldo", "etecsa", "dinero", "dinheiro", "deposito", "depósito", "cartão", "cartao", "habana", "efectivo", "entrega"];
const SAUDACOES = ["hola", "oi", "ola", "olá", "buenas", "bom dia", "boa tarde", "boa noite", "buen dia", "buenos dias", "buenas tardes", "buenas noches"];
const MUNICIPIOS = ["habana", "centro habana", "habana vieja", "cerro", "boyeros", "arroyo naranjo", "marianao"];
const IGNORAR_IA = ["ok", "si", "sí", "dale", "👍", "gracias", "listo", "entendido"];

const PIX_CHAVE = "8becaaf5-f296-4cbc-a115-46e3d23b042a";
const PIX_NOME  = "YORDANYS RAFAEL SOSA REYES\nNubank";

/* =========================
   UTILIDADES
========================= */
function escapeRegex(texto) { return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function contemPalavra(texto, palabra) {
  const segura = escapeRegex(palabra);
  const regex = new RegExp(`(^|\\s)${segura}(\\s|$)`, "iu");
  return regex.test(texto);
}

function resetEstado(phone) {
  estadoCliente[phone] = { operacion: null, etapa: "inicio", moeda: null, monto: null, municipio: null, tarjeta: null, numero: null, aguardando: null, pixEnviado: false, ultimoContato: Date.now() };
}

function getEstado(phone) {
  if (!estadoCliente[phone]) resetEstado(phone);
  else estadoCliente[phone].ultimoContato = Date.now();
  return estadoCliente[phone];
}

// Garbage Collector (Limpieza Total)
setInterval(() => {
  const agora = Date.now();
  for (const phone in estadoCliente) if (agora - estadoCliente[phone].ultimoContato > TTL_ESTADO_RAM) delete estadoCliente[phone];
  for (const phone in conversaAtiva) if (agora > conversaAtiva[phone]) delete conversaAtiva[phone];
  for (const phone in pausaHumana) if (agora > pausaHumana[phone]) delete pausaHumana[phone];
  for (const phone in flood) if (agora - flood[phone] > 60000) delete flood[phone];
}, 60 * 60 * 1000);

/* =========================
   APIS EXTERNAS
========================= */
async function enviarMensaje(phone, texto) {
  try {
    await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
    { phone, message: texto }, 
    { headers: { "Client-Token": ZAPI_CLIENT_TOKEN } });
  } catch (e) { console.log("ERRO ZAPI:", e.message); }
}

async function responderIA(mensagem, estado) {
  try {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Eres YordaBot. Asistente de remesas. Corto y natural." },
        { role: "user", content: `ESTADO: ${JSON.stringify(estado)}\nMSJ: ${mensagem}` }
      ],
      temperature: 0.4
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    return res.data.choices?.[0]?.message?.content?.trim() || "Dime 👍";
  } catch (e) { return "Dime 👍"; }
}

/* =========================
   MIDDLEWARE AUTORIZACIÓN
========================= */
function verificarAutorizacao(req, res, next) {
  const ip = req.ip || "";
  if (ip.includes("100.64.") || ip.includes("127.0.0.1") || ip.includes("::1")) return next();
  const queryToken = req.query.token;
  const clientToken = req.headers["client-token"] || req.headers["Client-Token"];
  if (WEBHOOK_SECRET && queryToken === WEBHOOK_SECRET) return next();
  if (ZAPI_CLIENT_TOKEN && clientToken && clientToken.trim() === ZAPI_CLIENT_TOKEN.trim()) return next();
  return res.sendStatus(401);
}

/* =========================
   WEBHOOK
========================= */
app.post("/webhook", verificarAutorizacao, async (req, res) => {
  const body = req.body;
  const phone = body.phone;
  if (!phone) return res.sendStatus(200);

  // --- 1. RATE LIMIT ANTI-SPAM (1.5s) ---
  if (flood[phone] && (Date.now() - flood[phone] < 1500)) {
    return res.sendStatus(200);
  }
  flood[phone] = Date.now();

  // --- 2. NORMALIZACIÓN Y FILTROS ---
  const fromApi = body.fromApi === true || body.fromApi === "true";
  const isGroup = body.isGroup === true || body.isGroup === "true";
  const status = String(body.status || "").trim().toUpperCase();

  if (fromApi || isGroup || String(phone).includes("-group") || String(phone).includes("@lid") || (status && status !== "RECEIVED")) {
    return res.sendStatus(200);
  }

  // --- 3. LOCK ATÓMICO ---
  if (locks[phone] && (Date.now() - locks[phone] < 10000)) {
    return res.sendStatus(200);
  }
  locks[phone] = Date.now();

  try {
    const fromMe = body.fromMe === true || body.fromMe === "true";
    if (fromMe && !String(phone).includes("-group") && !String(phone).includes("@lid")) {
      pausaHumana[phone] = Date.now() + PAUSA_HUMANA_MS;
      return res.sendStatus(200);
    }

    const texto = String(body?.text?.message || "");
    const enviouMidia = !!(body.image || body.video || body.document || body.audio || body.type === "image");
    if (!texto && !enviouMidia) return res.sendStatus(200);

    const hora = Number(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }));
    if (hora >= 22 || hora < 6 || (pausaHumana[phone] && Date.now() < pausaHumana[phone])) return res.sendStatus(200);

    // Regex compatible con Node antiguo/universal
    const textoLimpo = String(texto || "").toLowerCase().replace(/[^\w\s]/gi, "");

    if (conversaAtiva[phone] && Date.now() > conversaAtiva[phone]) {
      delete conversaAtiva[phone];
      resetEstado(phone);
    }

    const esComercial = GATILHOS.some(g => contemPalavra(textoLimpo, g));
    if (esComercial) conversaAtiva[phone] = Date.now() + CONVERSA_ATIVA_MS;
    const activa = conversaAtiva[phone] && Date.now() < conversaAtiva[phone];

    if (!esComercial && !activa) {
      if (SAUDACOES.some(s => contemPalavra(textoLimpo, s))) {
        await enviarMensaje(phone, `${hora < 12 ? "Buen día" : hora < 20 ? "Buenas tardes" : "Buenas noches"} 👋 ¿Cómo puedo ayudarte?`);
      }
      return res.sendStatus(200);
    }

    let estado = getEstado(phone);
    if (contemPalavra(textoLimpo, "recarga") || textoLimpo.includes("etecsa")) estado.operacion = "recarga";

    const matchMonto = texto.match(/\b\d{1,6}([.,]\d{1,2})?\b/);
    if (matchMonto && (estado.etapa === "esperando_monto" || ["real", "reales", "cup", "usd"].some(m => textoLimpo.includes(m)))) {
      estado.monto = matchMonto[0];
    }

    const soloD = texto.replace(/\D/g, "");
    if (estado.etapa === "esperando_tarjeta" && /^\d{16}$/.test(soloD)) estado.tarjeta = soloD;
    if (estado.etapa === "esperando_numero" && /^\d{8,11}$/.test(soloD)) estado.numero = soloD;

    // --- 4. VALIDACIÓN DE COMPROBANTE (Solo Media para Producción Real) ---
    if (estado.aguardando === "comprovante" && enviouMidia) {
      await enviarMensaje(phone, "Comprobante recibido 👌 Procesaremos su operación.");
      resetEstado(phone); 
      delete conversaAtiva[phone];
      return res.sendStatus(200);
    }

    if (estado.operacion === "recarga") {
      if (!estado.monto) { estado.etapa = "esperando_monto"; await enviarMensaje(phone, "¿De cuánto será la recarga?"); return res.sendStatus(200); }
      if (!estado.numero) { estado.etapa = "esperando_numero"; await enviarMensaje(phone, "Envíame el número a recargar 👌"); return res.sendStatus(200); }
      if (!estado.pixEnviado && estado.monto && estado.numero) { 
        estado.pixEnviado = true; estado.aguardando = "comprovante";
        await enviarMensaje(phone, `*Llave PIX:* \n${PIX_CHAVE}\n\n*Beneficiario:* \n${PIX_NOME}`); 
        return res.sendStatus(200); 
      }
    }

    if (estado.pixEnviado || IGNORAR_IA.includes(textoLimpo.trim())) {
      return res.sendStatus(200);
    }

    const aiRes = await responderIA(texto, estado);
    await enviarMensaje(phone, aiRes);
    res.sendStatus(200);

  } catch (e) { if (!res.headersSent) res.sendStatus(500); }
  finally { delete locks[phone]; }
});

app.get("/", (req, res) => res.send("YordaBot ONLINE"));

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Microservicio blindado en puerto ${PORT}`);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
