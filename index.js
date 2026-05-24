const express = require("express");
const axios = require("axios");
const xmlrpc = require("xmlrpc");
const Redis = require("ioredis");
const rateLimit = require("express-rate-limit");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(express.json({ limit: "10mb" }));
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
}));

const PORT = process.env.PORT || 8080;

const {
  OPENAI_API_KEY,
  OPENAI_ASSISTANT_ID,
  ZAPI_INSTANCE,
  ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN,
  ODOO_URL,
  ODOO_DB,
  ODOO_USER,
  ODOO_API_KEY,
  REDIS_URL
} = process.env;

// =========================
// PERSISTENCIA & CACHE REAL
// =========================
const redis = new Redis(REDIS_URL);
const stageCache = {}; // SOLUCIÓN 1: Cache de Stages funcional
const mensajesProcesados = new Set(); // SOLUCIÓN 2: Filtro de duplicados funcional
const buffers = {};
let cachedUid = null;

async function getThread(phone) { return await redis.get(`thread:${phone}`); }
async function setThread(phone, threadId) { await redis.set(`thread:${phone}`, threadId, "EX", 86400); }
async function getContext(phone) {
  const data = await redis.get(`ctx:${phone}`);
  return data ? JSON.parse(data) : null;
}
async function setContext(phone, data) { await redis.set(`ctx:${phone}`, JSON.stringify(data), "EX", 3600); }

function logger(level, event, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta }));
}

// Limpieza de duplicados cada 30 min
setInterval(() => mensajesProcesados.clear(), 1000 * 60 * 30);

// =========================
// ODOO CORE & OPTIMIZACIÓN
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

async function obtenerStageId(nombre) {
  if (stageCache[nombre]) return stageCache[nombre]; // Uso real del caché
  
  const uid = await autenticarOdoo();
  const models = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/object` });
  
  return new Promise((resolve) => {
    models.methodCall("execute_kw", [ODOO_DB, uid, ODOO_API_KEY, "crm.stage", "search_read", [[["name", "=", nombre]]], { fields: ["id"], limit: 1 }], (err, res) => {
      if (!err && res.length > 0) {
        stageCache[nombre] = res[0].id;
        resolve(res[0].id);
      } else resolve(null);
    });
  });
}

function detectarEtapa(texto) {
  const t = String(texto || "").toLowerCase();
  if (t.includes("pagué") || t.includes("pague") || t.includes("comprobante")) return "Pago confirmado";
  if (t.includes("finalizado") || t.includes("entregado")) return "Finalizado";
  if (t.includes("real") || t.includes("reales") || t.includes("cup") || t.includes("cuanto")) return "Tasa enviada";
  return "Interesado";
}

async function sincronizarOdoo(phone, mensaje) {
  try {
    const uid = await autenticarOdoo();
    const models = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/object` });
    const etapaNombre = detectarEtapa(mensaje);
    const stageId = await obtenerStageId(etapaNombre);

    models.methodCall("execute_kw", [ODOO_DB, uid, ODOO_API_KEY, "crm.lead", "search_read", [[["partner_name", "=", phone], ["type", "=", "opportunity"]]], { fields: ["id", "description"], limit: 1 }], async (err, leads) => {
      if (!err && leads.length > 0) {
        const lead = leads[0];
        // SOLUCIÓN 4: Append de descripción con historial
        const nuevaDesc = `${lead.description || ""}\n\n[${new Date().toLocaleString()}] ${mensaje}`;
        
        models.methodCall("execute_kw", [ODOO_DB, uid, ODOO_API_KEY, "crm.lead", "write", [[lead.id], { 
          description: nuevaDesc,
          stage_id: stageId || undefined 
        }]]);
      } else {
        models.methodCall("execute_kw", [ODOO_DB, uid, ODOO_API_KEY, "crm.lead", "create", [[{ 
          name: `WhatsApp: ${phone}`, 
          partner_name: phone, 
          description: `[${new Date().toLocaleString()}] ${mensaje}`, 
          type: "opportunity",
          stage_id: stageId || undefined
        }]]]);
      }
    });
  } catch (e) { logger("error", "ODOO_SYNC_ERROR", { err: e.message }); }
}

// =========================
// WHATSAPP & AGENT
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
    const run = await axios.post(`https://api.openai.com/v1/threads/${threadId}/runs`, { assistant_id: OPENAI_ASSISTANT_ID }, { headers });
    
    const startedAt = Date.now();
    let completed = false;
    while (!completed) {
      if (Date.now() - startedAt > 45000) throw new Error("Timeout");
      await new Promise(r => setTimeout(r, 1500));
      const check = await axios.get(`https://api.openai.com/v1/threads/${threadId}/runs/${run.data.id}`, { headers });
      if (check.data.status === "completed") completed = true;
      if (["failed", "expired"].includes(check.data.status)) throw new Error("Run failed");
    }
    const msgs = await axios.get(`https://api.openai.com/v1/threads/${threadId}/messages`, { headers });
    const respuesta = msgs.data.data[0]?.content[0]?.text?.value;
    if (respuesta) await enviarMensaje(phone, respuesta.replace(/\*/g, ''));
  } catch (e) { logger("error", "AGENT_ERROR", { err: e.message }); }
}

// =========================
// WEBHOOK (SOLUCIÓN 5: ANTI-LOOP)
// =========================
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    // SOLUCIÓN 2: Uso real de mensajesProcesados (messageId)
    if (!body.phone || body.isGroup || !body.text?.message || !body.messageId) return res.sendStatus(200);
    if (mensajesProcesados.has(body.messageId)) return res.sendStatus(200);
    
    mensajesProcesados.add(body.messageId);

    const phone = body.phone.replace(/\D/g, "");
    const textMessage = body.text.message.trim();

    if (body.fromMe) {
      const ctx = await getContext(phone) || {};
      ctx.humano = true;
      ctx.ultimaInteracao = Date.now();
      await setContext(phone, ctx);
      return res.sendStatus(200);
    }

    const ctx = await getContext(phone) || { ativa: false, ultimaInteracao: 0, humano: false };
    if (ctx.humano && (Date.now() - ctx.ultimaInteracao) > 1800000) ctx.humano = false;
    if (ctx.humano) return res.sendStatus(200);

    const lower = textMessage.toLowerCase();
    // SOLUCIÓN 3: Regex de monto seguro
    const tieneMontoSeguro = /\b\d+\s?(real|reales|r\$|cup|usd|mlc)\b/i.test(lower);
    const gatillos = ["remesa", "envio", "enviar", "pix", "pagar", "cambio"];
    const esNegocio = gatillos.some(g => lower.includes(g)) || tieneMontoSeguro;
    const conversaExiste = (Date.now() - ctx.ultimaInteracao) < 1800000;

    if (!esNegocio && !conversaExiste) return res.sendStatus(200);

    ctx.ativa = true;
    ctx.ultimaInteracao = Date.now();
    await setContext(phone, ctx);
    
    // Sincronización optimizada
    sincronizarOdoo(phone, textMessage);

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

app.get("/", async (req, res) => {
  try { await redis.ping(); res.json({ status: "online", redis: true }); }
  catch { res.status(500).json({ status: "error" }); }
});

app.listen(PORT, "0.0.0.0", () => logger("info", `SERVER_SECURE_UP_${PORT}`));
