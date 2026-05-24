const express = require("express");
const axios = require("axios");
const xmlrpc = require("xmlrpc");
const Redis = require("ioredis");
const rateLimit = require("express-rate-limit");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8080; // Definido al inicio para evitar errores

app.use(express.json({ limit: "10mb" }));
app.set("trust proxy", 1);
app.disable("x-powered-by");

// =========================
// REDIS (PERSISTENCIA)
// =========================
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
  redis.on("connect", () => console.log("✅ Redis conectado"));
  redis.on("error", (err) => console.log("⚠️ Redis error:", err.message));
} else {
  console.log("⚠️ REDIS_URL no configurado. Continuando sin Redis.");
}

// =========================
// RATE LIMIT
// =========================
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120
}));

// =========================
// ENV & VALIDACIÓN
// =========================
const {
  OPENAI_API_KEY,
  OPENAI_ASSISTANT_ID,
  ZAPI_INSTANCE,
  ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN,
  ODOO_URL,
  ODOO_DB,
  ODOO_USER,
  ODOO_API_KEY
} = process.env;

const required = ["OPENAI_API_KEY", "OPENAI_ASSISTANT_ID", "ZAPI_INSTANCE", "ZAPI_TOKEN", "ZAPI_CLIENT_TOKEN", "ODOO_URL", "ODOO_DB", "ODOO_USER", "ODOO_API_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.log(`❌ ENV faltante: ${key}`);
    process.exit(1);
  }
}

// =========================
// MEMORIA LOCAL & CACHE
// =========================
const threads = new Map();
const mensajesProcesados = new Set();
const humanTakeover = {};
const stageCache = {};
const buffers = {};
let odooUid = null;

setInterval(() => mensajesProcesados.clear(), 1000 * 60 * 30);

function logger(level, event, meta = {}) {
  console.log(JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...meta }));
}

// =========================
// ODOO CORE (STAGES & SYNC)
// =========================
async function getOdooUid() {
  if (odooUid) return odooUid;
  return new Promise((resolve, reject) => {
    const common = xmlrpc.createSecureClient({ url: `${ODOO_URL.replace(/\/$/, "")}/xmlrpc/2/common` });
    common.methodCall("authenticate", [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}], (err, uid) => {
      if (err || !uid) return reject(err || new Error("UID Inválido"));
      odooUid = uid;
      resolve(uid);
    });
  });
}

function detectarEtapa(texto) {
  const t = String(texto || "").toLowerCase();
  if (t.includes("pagué") || t.includes("pague") || t.includes("comprobante") || t.includes("listo")) return "Pago confirmado";
  if (t.includes("finalizado") || t.includes("entregado")) return "Finalizado";
  if (t.includes("cuanto") || t.includes("tasa") || t.includes("envio") || t.includes("pesos") || t.includes("reales")) return "Tasa enviada";
  return "Interesado";
}

async function obtenerStageId(models, uid, nombre) {
  if (stageCache[nombre]) return stageCache[nombre];
  return new Promise((resolve, reject) => {
    models.methodCall("execute_kw", [ODOO_DB, uid, ODOO_API_KEY, "crm.stage", "search_read", [[["name", "=", nombre]]], { fields: ["id"], limit: 1 }], (err, res) => {
      if (err) return reject(err);
      if (!res?.length) return resolve(null);
      stageCache[nombre] = res[0].id;
      resolve(res[0].id);
    });
  });
}

async function sincronizarOdoo(phone, mensaje) {
  try {
    const uid = await getOdooUid();
    const models = xmlrpc.createSecureClient({ url: `${ODOO_URL.replace(/\/$/, "")}/xmlrpc/2/object` });
    const etapa = detectarEtapa(mensaje);
    const stageId = await obtenerStageId(models, uid, etapa);

    models.methodCall("execute_kw", [ODOO_DB, uid, ODOO_API_KEY, "crm.lead", "search_read", [[["partner_name", "=", phone]]], { fields: ["id", "description"], limit: 1 }], async (err, leads) => {
      if (err) return;
      
      if (leads && leads.length > 0) {
        const lead = leads[0];
        const nuevoHistorial = `${lead.description || ""}\n\n━━━━━━━━━━\n${new Date().toLocaleString()}\n${mensaje}`;
        models.methodCall("execute_kw", [ODOO_DB, uid, ODOO_API_KEY, "crm.lead", "write", [[lead.id], { description: nuevoHistorial, stage_id: stageId || undefined }]]);
      } else {
        models.methodCall("execute_kw", [ODOO_DB, uid, ODOO_API_KEY, "crm.lead", "create", [[{ name: `WhatsApp: ${phone}`, partner_name: phone, description: mensaje, type: "opportunity", stage_id: stageId || undefined }]]]);
      }
    });
  } catch (e) { logger("error", "ODOO_FATAL", { err: e.message }); }
}

// =========================
// WHATSAPP & OPENAI
// =========================
async function enviarMensaje(phone, message) {
  try {
    await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
      { phone, message: String(message).replace(/\*/g, "").trim(), checkContact: false },
      { headers: { "Client-Token": ZAPI_CLIENT_TOKEN }, timeout: 15000 }
    );
  } catch (e) { logger("error", "ZAPI_SEND_ERROR", { err: e.message }); }
}

async function procesarMensaje(phone, textMessage) {
  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json", "OpenAI-Beta": "assistants=v2" };
  try {
    let threadId = threads.get(phone);
    if (!threadId && redis) {
      threadId = await redis.get(`thread:${phone}`);
      if (threadId) threads.set(phone, threadId);
    }
    if (!threadId) {
      const thread = await axios.post("https://api.openai.com/v1/threads", {}, { headers });
      threadId = thread.data.id;
      threads.set(phone, threadId);
      if (redis) await redis.set(`thread:${phone}`, threadId);
    }

    await axios.post(`https://api.openai.com/v1/threads/${threadId}/messages`, { role: "user", content: textMessage }, { headers });
    const run = await axios.post(`https://api.openai.com/v1/threads/${threadId}/runs`, { assistant_id: OPENAI_ASSISTANT_ID }, { headers });
    
    const startedAt = Date.now();
    let completed = false;
    while (!completed) {
      if (Date.now() - startedAt > 45000) throw new Error("RUN_TIMEOUT");
      await new Promise(r => setTimeout(r, 1500));
      const check = await axios.get(`https://api.openai.com/v1/threads/${threadId}/runs/${run.data.id}`, { headers });
      if (check.data.status === "completed") completed = true;
      else if (["failed", "expired", "cancelled"].includes(check.data.status)) throw new Error(`RUN_${check.data.status}`);
    }

    const messages = await axios.get(`https://api.openai.com/v1/threads/${threadId}/messages`, { headers });
    const respuesta = messages.data.data[0]?.content?.[0]?.text?.value?.trim();
    if (respuesta) await enviarMensaje(phone, respuesta);
  } catch (e) { logger("error", "OPENAI_ERROR", { phone, err: e.message }); }
}

// =========================
// WEBHOOK
