const express = require("express");
const axios = require("axios");

// --- 1. FAIL-FAST & CONFIG ---
const requiredEnv = ["OPENAI_API_KEY", "ZAPI_INSTANCE", "ZAPI_TOKEN", "ZAPI_CLIENT_TOKEN"];
requiredEnv.forEach(key => { if (!process.env[key]) process.exit(1); });

const logger = (level, event, dados = {}) => {
  console.log(JSON.stringify({ level, event, timestamp: new Date().toISOString(), ...dados }));
};

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 8080;
const { OPENAI_API_KEY, ZAPI_INSTANCE, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, WEBHOOK_SECRET } = process.env;

/* =========================
   MEMORIA Y COLAS (HARDENED)
========================= */
const estadoCliente = {}; 
const queues = {}; 
const flood = {}; 
const buffers = {}; 

const STOP_WORDS = ["ok", "gracias", "listo", "enviado", "ya pague", "hecho", "👍", "vale", "dale"];
const SAUDACOES = ["hola", "buenas", "buen dia", "oi", "ola", "tasa", "precio"];

const PIX_CHAVE = "8becaaf5-f296-4cbc-a115-46e3d23b042a";
const PIX_NOME  = "YORDANYS RAFAEL SOSA REYES\nNubank";

/* =========================
   UTILIDADES
========================= */
const normalize = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\w\s]/g, "").trim();
const escapeRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const contemPalavra = (t, p) => new RegExp(`(^|\\s)${escapeRegex(p)}(\\s|$)`, "iu").test(t);

const resetEstado = (phone) => {
  estadoCliente[phone] = { operacion: null, etapa: "inicio", monto: null, numero: null, aguardando: null, pixEnviado: false, ultimoContato: Date.now() };
};

const getEstado = (phone) => {
  if (!estadoCliente[phone]) resetEstado(phone);
  estadoCliente[phone].ultimoContato = Date.now();
  return estadoCliente[phone];
};

// Garbage Collector Pro (Limpieza de Colas y RAM)
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
   PROCESAMIENTO SERIAL (v1.12)
========================= */
async function processarIntencao(phone, textoCompleto, tieneMedia, esAudio) {
  const start = Date.now();
  let estado = getEstado(phone);
  const textoSeguro = String(textoCompleto || "").slice(0, 1200); 
  const textoLimpo = normalize(textoSeguro);

  try {
    if (esAudio) {
        return await enviarMensaje(phone, "No puedo procesar audios 👌\n\nEscríbeme:\n- Monto\n- Destino\n- Operación");
    }

    if (!estado.operacion && !tieneMedia) {
        if (SAUDACOES.some(s => textoLimpo.includes(s))) {
            return await enviarMensaje(phone, "Hola 👌 ¿En qué puedo ayudarte?");
        }
    }

    if (["cancelar", "nuevo", "reiniciar", "cambiar"].some(w => textoLimpo.includes(w))) {
      resetEstado(phone);
      return await enviarMensaje(phone, "Listo 👌 Operación cancelada.");
    }

    if (estado.aguardando === "comprovante") {
      if (tieneMedia) {
        await enviarMensaje(phone, "Perfecto 👌 Recibimos el comprobante.");
        return resetEstado(phone);
      }
      return; 
    }

    const nuevaOp = ["recarga", "saldo"].some(g => contemPalavra(textoLimpo, g)) ? "recarga" :
                    ["remesa", "envio", "enviar", "transferir"].some(g => contemPalavra(textoLimpo, g)) ? "remesa" : null;

    if (nuevaOp && nuevaOp !== estado.operacion) {
      resetEstado(phone);
      estado = getEstado(phone);
      estado.operacion = nuevaOp;
    }

    const soloD = textoSeguro.replace(/\D/g, "");
    if (estado.etapa === "esperando_numero" && /^\d{8,16}$/.test(soloD)) estado.numero = soloD;
    
    const matchMonto = textoSeguro.match(/\b\d{1,5}([.,]\d{1,2})?\b/);
    if (matchMonto && (estado.etapa === "esperando_monto" || (estado.operacion && !estado.monto))) {
      if (matchMonto[0] !== estado.numero) estado.monto = matchMonto[0];
    }

    if (estado.operacion) {
      if (!estado.monto) {
        estado.etapa = "esperando_monto";
        return await enviarMensaje(phone, `¿De cuánto es la ${estado.operacion}? 👌`);
      }
      if (!estado.numero) {
        estado.etapa = "esperando_numero";
        return await enviarMensaje(phone, estado.operacion === "recarga" ? "Dime el número 👌" : "Dime la tarjeta o cuenta 👌");
      }
      if (!estado.pixEnviado) {
        estado.pixEnviado = true;
        estado.aguardando = "comprovante";
        return await enviarMensaje(phone, `*Total:* ${estado.monto}\n*Destino:* ${estado.numero}\n\n*Llave PIX:* \n${PIX_CHAVE}\n\nEnvíame el comprobante 👌`);
      }
      return; 
    }

    if (STOP_WORDS.some(w => textoLimpo.includes(w))) return;

    // --- FIX #2: TIMEOUT ESPECÍFICO IA (12s) ---
    const aiRes = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Eres YordaBot. Gestor de remesas. Corto y humano. Máximo 15 palabras. Usa emojis 👌." },
        { role: "user", content: textoSeguro }
      ],
      temperature: 0.3
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, timeout: 12000 });

    await enviarMensaje(phone, aiRes.data.choices[0].message.content.trim());
    logger("info", "PROC_SUCCESS", { phone, duration: Date.now() - start });

  } catch (e) { logger("error", "PROC_ERR", { phone, err: e.message }); }
}

/* =========================
   WEBHOOK (GESTIÓN DE COLAS)
========================= */
app.post("/webhook", async (req, res) => {
  if (WEBHOOK_SECRET && (req.query.token || req.headers["x-webhook-secret"]) !== WEBHOOK_SECRET) return res.sendStatus(401);

  const body = req.body;
  const phone = body.phone;
  const status = String(body.status || "").toUpperCase();
  const fromMe = body.fromMe === true || body.fromMe === "true";

  if (status && status !== "RECEIVED") return res.sendStatus(200);
  if (!phone || fromMe || body.isGroup || String(body.chatLid).includes("@lid")) return res.sendStatus(200);

  const agora = Date.now();
  if (flood[phone] && (agora - flood[phone] < 1000)) return res.sendStatus(200);
  flood[phone] = agora;

  if (!buffers[phone]) buffers[phone] = { texts: [], hasMedia: false, esAudio: false, timer: null, last: agora };

  const msgText = body?.text?.message || "";
  if (msgText) {
      buffers[phone].texts.push(msgText);
      if (buffers[phone].texts.length > 15) buffers[phone].texts.shift();
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
    
    // --- FIX #3: LÍMITE DE COLA (Anti-Spam) ---
    if (queues[phone].tasks.length > 25) {
        queues[phone].tasks.shift(); 
    }
    queues[phone].tasks.push({ fullText, media, audio });
    queues[phone].last = Date.now();

    if (!queues[phone].processing) {
        queues[phone].processing = true;
        // --- FIX #1: TRY/FINALLY EN LA FILA (Evita bloqueo permanente) ---
        try {
            while (queues[phone].tasks.length > 0) {
                const task = queues[phone].tasks.shift();
                await processarIntencao(phone, task.fullText, task.media, task.audio);
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

app.get("/", (req, res) => res.send("YordaBot v1.12 - Hardened Queue"));

const server = app.listen(PORT, "0.0.0.0", () => logger("info", "SERVER_START", { port: PORT }));
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
