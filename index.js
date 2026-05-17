const express = require("express");
const axios = require("axios");

// --- 1. FAIL-FAST & CONFIG ---
const requiredEnv = ["ZAPI_INSTANCE", "ZAPI_TOKEN", "ZAPI_CLIENT_TOKEN", "AGENTE_URL"];
requiredEnv.forEach(key => { if (!process.env[key]) process.exit(1); });

const logger = (level, event, dados = {}) => {
  console.log(JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...dados }));
};

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 8080;
const { ZAPI_INSTANCE, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, WEBHOOK_SECRET, AGENTE_URL } = process.env;

/* =========================
   MEMORIA Y COLAS (PROXY)
========================= */
const estadoCliente = {}; 
const queues = {}; 
const flood = {}; 
const buffers = {}; 

const resetEstado = (phone) => {
  estadoCliente[phone] = { operacion: null, etapa: "inicio", monto: null, numero: null, aguardando: null, pixEnviado: false, ultimoContato: Date.now() };
};

const getEstado = (phone) => {
  if (!estadoCliente[phone]) resetEstado(phone);
  estadoCliente[phone].ultimoContato = Date.now();
  return estadoCliente[phone];
};

// Garbage Collector (Higiene de RAM)
setInterval(() => {
  const agora = Date.now();
  Object.keys(estadoCliente).forEach(p => { if (agora - estadoCliente[p].ultimoContato > 86400000) delete estadoCliente[p]; });
  Object.keys(queues).forEach(p => { if (!queues[p].processing && agora - queues[p].last > 60000) delete queues[p]; });
  Object.keys(flood).forEach(p => { if (agora - flood[p] > 60000) delete flood[p]; });
  Object.keys(buffers).forEach(p => { if (agora - buffers[p].last > 30000) delete buffers[p]; });
}, 60000);

/* =========================
   SISTEMA DE COMUNICACIÓN
========================= */
async function enviarMensaje(phone, message, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
        { phone, message }, { timeout: 15000, headers: { "Client-Token": ZAPI_CLIENT_TOKEN } });
      return;
    } catch (e) {
      if (i === retries) logger("error", "ERR_ZAPI", { phone, error: e.message });
      else await new Promise(r => setTimeout(r, 1000));
    }
  }
}

/* =========================
   PROCESAMIENTO PROXY (v2.0)
========================= */
async function procesarHaciaAgente(phone, textoCompleto, tieneMedia, esAudio) {
  const start = Date.now();
  const estadoActual = getEstado(phone);
  const textoSeguro = String(textoCompleto || "").slice(0, 1500); 

  try {
    // --- LLAMADA AL AGENTE EXTERNO (El Cerebro) ---
    const agenteRes = await axios.post(AGENTE_URL, {
      phone,
      texto: textoSeguro,
      estado: estadoActual,
      media: tieneMedia,
      audio: esAudio,
      timestamp: Date.now()
    }, { timeout: 20000 });

    const { reply, state, internalLog } = agenteRes.data;

    // 1. Sincronización de Estado (Si el Agente lo solicita)
    if (state) {
      estadoCliente[phone] = {
        ...estadoActual,
        ...state,
        ultimoContato: Date.now()
      };
    }

    // 2. Ejecución de Respuesta
    if (reply) {
      await enviarMensaje(phone, reply);
    }

    if (internalLog) logger("info", "AGENT_INTERNAL_LOG", { phone, ...internalLog });
    logger("info", "PROC_SUCCESS", { phone, duration: Date.now() - start });

  } catch (e) {
    logger("error", "AGENT_COMM_ERR", { phone, err: e.message });
    // Opcional: Notificar al usuario que hay una demora técnica
  }
}

/* =========================
   WEBHOOK (GESTIÓN DE COLAS)
========================= */
app.post("/webhook", async (req, res) => {
  // Seguridad de Webhook
  if (WEBHOOK_SECRET && (req.query.token || req.headers["x-webhook-secret"]) !== WEBHOOK_SECRET) return res.sendStatus(401);

  const body = req.body;
  const phone = body.phone;
  const status = String(body.status || "").toUpperCase();
  const fromMe = body.fromMe === true || body.fromMe === "true";

  if (status && status !== "RECEIVED") return res.sendStatus(200);
  if (!phone || fromMe || body.isGroup || String(body.chatLid).includes("@lid")) return res.sendStatus(200);

  // Flood Control
  const agora = Date.now();
  if (flood[phone] && (agora - flood[phone] < 1000)) return res.sendStatus(200);
  flood[phone] = agora;

  // Buffer / Debounce
  if (!buffers[phone]) buffers[phone] = { texts: [], hasMedia: false, esAudio: false, timer: null, last: agora };

  const msgText = body?.text?.message || "";
  if (msgText) {
      buffers[phone].texts.push(msgText);
      if (buffers[phone].texts.length > 20) buffers[phone].texts.shift();
  }

  const tipo = String(body.type || "").toLowerCase();
  if (tipo.includes("image") || tipo.includes("document") || body.image || body.document) buffers[phone].hasMedia = true;
  if (tipo.includes("audio") || tipo.includes("ptt")) buffers[phone].esAudio = true;

  buffers[phone].last = agora;
  if (buffers[phone].timer) clearTimeout(buffers[phone].timer);

  buffers[phone].timer = setTimeout(async () => {
    const fullText = buffers[phone].texts.join(" ");
    const media = buffers[phone].hasMedia;
    const audio = buffers[phone].esAudio;
    delete buffers[phone];

    if (!queues[phone]) queues[phone] = { tasks: [], processing: false, last: Date.now() };
    
    if (queues[phone].tasks.length > 25) queues[phone].tasks.shift();
    queues[phone].tasks.push({ fullText, media, audio });
    queues[phone].last = Date.now();

    if (!queues[phone].processing) {
        queues[phone].processing = true;
        try {
            while (queues[phone].tasks.length > 0) {
                const task = queues[phone].tasks.shift();
                await procesarHaciaAgente(phone, task.fullText, task.media, task.audio);
            }
        } catch (e) {
            logger("error", "QUEUE_CRASH", { phone, err: e.message });
        } finally {
            queues[phone].processing = false;
        }
    }
  }, 1500);

  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("YordaProxy v2.0 - Agent Orquestator"));

const server = app.listen(PORT, "0.0.0.0", () => logger("info", "SERVER_START", { port: PORT }));
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
