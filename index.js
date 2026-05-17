const express = require("express");
const axios = require("axios");
const xmlrpc = require("xmlrpc");
const Redis = require("ioredis");
const rateLimit = require("express-rate-limit");

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", true);

// =========================
// MIDDLEWARES
// =========================
app.use(express.json({ limit: "10mb" }));
app.use(rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 100, // Máximo 100 peticiones por minuto por IP
  standardHeaders: true,
  legacyHeaders: false
}));

const PORT = process.env.PORT || 8080;

// =========================
// ENV & VALIDACIÓN
// =========================
const {
  OPENAI_API_KEY,
  ZAPI_INSTANCE,
  ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN,
  ODOO_URL,
  ODOO_DB,
  ODOO_USER,
  ODOO_API_KEY,
  REDIS_URL
} = process.env;

const required = ["OPENAI_API_KEY", "REDIS_URL", "ODOO_URL", "ZAPI_TOKEN"]; // Simplificado para brevedad
for (const key of required) { if (!process.env[key]) { console.log(`❌ ENV faltante: ${key}`); process.exit(1); } }

// =========================
// REDIS & CACHE
// =========================
const redis = new Redis(REDIS_URL);
const cacheTasas = {};
const flood = {};
const buffers = {};
const mensajesProcesados = new Set();
let cachedUid = null;

// =========================
// FUNCIONES REDIS
// =========================
async function getThread(phone) { return await redis.get(`thread:${phone}`); }
async function setThread(phone, threadId) { await redis.set(`thread:${phone}`, threadId, "EX", 86400); }
async function getContext(phone) {
  const data = await redis.get(`ctx:${phone}`);
  return data ? JSON.parse(data) : null;
}
async function setContext(phone, data) { await redis.set(`ctx:${phone}`, JSON.stringify(data), "EX", 3600); }
async function deleteContext(phone) {
  await redis.del(`ctx:${phone}`);
  await redis.del(`thread:${phone}`);
}

// =========================
// LOGGER ESTRUCTURADO (MEJORA 9)
// =========================
function logger(level, event, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta }));
}

// =========================
// ODOO & TASAS (MEJORA 7)
// =========================
async function autenticarOdoo() {
  if (cachedUid) return cachedUid;
  return new Promise((resolve, reject) => {
    const urlLimpia = String(ODOO_URL).replace(/\/$/, "");
    const common = xmlrpc.createSecureClient({ url: `${urlLimpia}/xmlrpc/2/common` });
    common.methodCall("authenticate", [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}], (err, uid) => {
      if (err || !uid) return reject(err || new Error("UID inválido"));
      cachedUid = uid;
      resolve(uid);
    });
  });
}

async function consultarTasasOdoo(tipoMoneda = "CUP") {
  const cacheKey = `tasas:${tipoMoneda}`;
  if (cacheTasas[cacheKey] && (Date.now() - cacheTasas[cacheKey].time) < 30000) {
    return cacheTasas[cacheKey].data;
  }

  return new Promise(async (resolve, reject) => {
    try {
      const uid = await autenticarOdoo();
      const urlLimpia = String(ODOO_URL).replace(/\/$/, "");
      const models = xmlrpc.createSecureClient({ url: `${urlLimpia}/xmlrpc/2/object` });
      let refs = tipoMoneda === "CUP" ? ["TASA_CUP_BAJA", "TASA_CUP_MEDIA", "TASA_CUP_ALTA"] : [`TASA_${tipoMoneda}`];

      models.methodCall("execute_kw", [
        ODOO_DB, uid, ODOO_API_KEY, "product.product", "search_read",
        [[["default_code", "in", refs]]], { fields: ["default_code", "list_price"] }
      ], (err, products) => {
        if (err) return reject(err);
        const tasas = {};
        products.forEach(p => { tasas[p.default_code] = p.list_price; });
        cacheTasas[cacheKey] = { data: tasas, time: Date.now() }; // Cacheado
        resolve(tasas);
      });
    } catch (e) { reject(e); }
  });
}

// =========================
// PROCESAR MENSAJE (ASSISTANT + TOOLS)
// =========================
async function enviarMensaje(phone, message) {
  await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
    { phone, message, checkContact: false }, { headers: { "Client-Token": ZAPI_CLIENT_TOKEN } });
}

async function procesarMensaje(phone, textMessage) {
  try {
    const headers = { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json", "OpenAI-Beta": "assistants=v2" };
    let threadId = await getThread(phone);
    if (!threadId) {
      const thread = await axios.post("https://api.openai.com/v1/threads", {}, { headers });
      threadId = thread.data.id;
      await setThread(phone, threadId);
    }

    await axios.post(`https://api.openai.com/v1/threads/${threadId}/messages`, { role: "user", content: textMessage }, { headers });
    let run = await axios.post(`https://api.openai.com/v1/threads/${threadId}/runs`, { assistant_id: "asst_0iCMGSSNWcXP7H6Eo1yEM536" }, { headers });

    const startedAt = Date.now();
    let completed = false;
    while (!completed) {
      if (Date.now() - startedAt > 45000) throw new Error("Run timeout");
      await new Promise(r => setTimeout(r, 1500));
      const check = await axios.get(`https://api.openai.com/v1/threads/${threadId}/runs/${run.data.id}`, { headers });
      
      if (check.data.status === "completed") completed = true;
      else if (check.data.status === "requires_action") {
        const toolCalls = check.data.required_action.submit_tool_outputs.tool_calls;
        const outputs = [];
        for (const tc of toolCalls) {
          const args = JSON.parse(tc.function.arguments);
          const res = await consultarTasasOdoo(args.tipo_envio);
          outputs.push({ tool_call_id: tc.id, output: JSON.stringify(res) });
        }
        await axios.post(`https://api.openai.com/v1/threads/${threadId}/runs/${run.data.id}/submit_tool_outputs`, { tool_outputs: outputs }, { headers });
      } else if (["failed", "expired"].includes(check.data.status)) throw new Error("Run failed");
    }

    const messages = await axios.get(`https://api.openai.com/v1/threads/${threadId}/messages`, { headers });
    const respuesta = messages.data.data[0]?.content?.[0]?.text?.value;
    if (respuesta) await enviarMensaje(phone, respuesta);
  } catch (e) { 
    logger("error", "AGENT_ERROR", { phone, err: e.message });
    await enviarMensaje(phone, "Lo siento, tengo una demora momentánea 🙏");
  }
}

// =========================
// MEJORA 8: RESPUESTA RÁPIDA (FALLBACK)
// =========================
function respuestaRapida(texto) {
  const lower = texto.toLowerCase();
  if (lower === "hola" || lower === "oi") return "Hola 😊 ¿Cómo puedo ayudarte?";
  if (lower.includes("pix")) return "PIX:\n8becaaf5-f296-4cbc-a115-46e3d23b042a\n\nTitular: Yordanys Rafael Sosa Reyes";
  return null;
}

// =========================
// WEBHOOK (SAAS LOGIC)
// =========================
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    if (!body.phone || body.fromMe || body.isGroup || !body.text?.message) return res.sendStatus(200);

    const phone = body.phone.replace(/\D/g, "");
    const textMessage = body.text.message.trim();
    const lower = textMessage.toLowerCase();

    // Anti-Spam (Flood)
    const now = Date.now();
    if (flood[phone] && (now - flood[phone]) < 1500) return res.sendStatus(200);
    flood[phone] = now;

    // MEJORA 5: MODO HUMANO
    const contexto = await getContext(phone) || { ativa: false, ultimaInteracao: 0, leadRegistrado: false, humano: false };
    if (contexto.humano) return res.sendStatus(200);

    // MEJORA 8: FAST REPLY
    const fastReply = respuestaRapida(textMessage);
    if (fastReply) {
      await enviarMensaje(phone, fastReply);
      return res.sendStatus(200);
    }

    // Filtrado de Negocio
    const gatillos = ["remesa", "envio", "enviar", "transferencia", "mandar", "cup", "mlc", "usd", "pix", "real", "reais", "rs"];
    const palabras = lower.replace(/[^\w\s$]/g, "").split(/\s+/);
    const esNegocio = gatillos.some(g => palabras.includes(g)) || /\d+/.test(lower);
    const conversaExiste = (now - contexto.ultimaInteracao) < 1800000;

    if (!esNegocio && !conversaExiste) return res.sendStatus(200);

    // Actualizar Contexto (Redis)
    contexto.ativa = true;
    contexto.ultimaInteracao = now;
    await setContext(phone, contexto);

    // Buffer
    if (!buffers[phone]) buffers[phone] = { texts: [], timer: null };
    buffers[phone].texts.push(textMessage);
    clearTimeout(buffers[phone].timer);
    buffers[phone].timer = setTimeout(async () => {
      const fullText = buffers[phone].texts.join(" ");
      delete buffers[phone];
      await procesarMensaje(phone, fullText);
    }, 2000);

    res.sendStatus(200);
  } catch (e) { res.sendStatus(200); }
});

// MEJORA 10: HEALTHCHECK
app.get("/", async (req, res) => {
  try {
    await redis.ping();
    res.json({ status: "online", redis: true, openai: true, uptime: process.uptime() });
  } catch { res.status(500).json({ status: "error" }); }
});

app.listen(PORT, "0.0.0.0", () => logger("info", `SAAS_ACTIVE_PORT_${PORT}`));
