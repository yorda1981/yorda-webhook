const express = require("express");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();

// CONFIGURACIÓN
app.use(express.json({ limit: "10mb" }));
app.set("trust proxy", 1);
app.disable("x-powered-by");

// ESTÁTICOS
app.use(express.static(path.join(__dirname, "public")));

// SERVICIOS
const redis = require("./src/services/redis");
const { procesarMensaje } = require("./src/services/openai");
const logger = require("./src/utils/logger");
const { detectarIntencion } = require("./src/engines/intent-engine");

// RATE LIMIT
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
  })
);

// MEMORIA TEMPORAL
const mensajesProcesados = new Set();
const humanTakeover = {};
const buffers = {};

// LIMPIAR DUPLICADOS CADA 30 MIN
setInterval(() => {
  mensajesProcesados.clear();
}, 1000 * 60 * 30);

// WEBHOOK PRINCIPAL
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const messageId = body.messageId || body.id || "";

    // Evitar duplicados
    if (mensajesProcesados.has(messageId)) {
      return res.sendStatus(200);
    }
    if (messageId) mensajesProcesados.add(messageId);

    const fromMe = body.fromMe === true || body.fromMe === "true";
    const isGroup = body.isGroup === true || body.isGroup === "true";
    const phone = String(body.phone || body.chatId || body.from || "").replace(/\D/g, "");

    const textMessage = String(
      body.text?.message ||
      body.message?.conversation ||
      body.message?.extendedTextMessage?.text ||
      body.message?.imageMessage?.caption ||
      body.body ||
      body.text ||
      body.caption ||
      ""
    ).trim();

    if (!phone || !textMessage || isGroup) {
      return res.sendStatus(200);
    }

    // Lógica de Takeover (Intervención Humana)
    if (fromMe) {
      humanTakeover[phone] = Date.now();
      if (redis) {
        await redis.set("ctx:" + phone, JSON.stringify({ humano: true }), "EX", 60 * 30);
      }
      return res.sendStatus(200);
    }

    let ctx = null;
    if (redis) {
      const redisCtx = await redis.get("ctx:" + phone);
      if (redisCtx) ctx = JSON.parse(redisCtx);
    }

    if (ctx?.humano || (humanTakeover[phone] && Date.now() - humanTakeover[phone] < 1000 * 60 * 30)) {
      console.log("👨 TAKEOVER ACTIVO");
      return res.sendStatus(200);
    }

    // Detección de Intención
    const esNegocio = detectarIntencion(textMessage);
    if (!esNegocio) {
      logger("info", "IGNORED_MESSAGE", { phone, message: textMessage });
      return res.sendStatus(200);
    }

    // Buffer de mensajes (agrupar ráfagas de mensajes)
    if (!buffers[phone]) {
      buffers[phone] = { textos: [], timeout: null };
    }

    buffers[phone].textos.push(textMessage);
    clearTimeout(buffers[phone].timeout);

    buffers[phone].timeout = setTimeout(async () => {
      try {
        const finalMessage = buffers[phone].textos.join("\n");
        delete buffers[phone];

        logger("info", "MESSAGE_RECEIVED", { phone, message: finalMessage });
        await procesarMensaje(phone, finalMessage);
      } catch (e) {
        logger("error", "BUFFER_ERROR", { err: e.message });
      }
    }, 1500);

    return res.sendStatus(200);
  } catch (e) {
    logger("error", "WEBHOOK_ERROR", { err: e.message });
    return res.sendStatus(200);
  }
});

// ADMIN: ESTADÍSTICAS
app.get("/admin/stats", async (req, res) => {
  try {
    const { obtenerTodos } = require("./src/services/customer-memory");
    const clientes = obtenerTodos();
    let stats = { clientes: 0, vip: 0, operaciones: 0, total: 0 };

    for (const [phone, data] of clientes) {
      stats.clientes++;
      stats.operaciones += data.totalOperaciones || 0;
      stats.total += data.totalEnviado || 0;
      if (data.vip) stats.vip++;
    }
    return res.json(stats);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ADMIN: VER TASAS
app.get("/admin/tasas", async (req, res) => {
  try {
    const filePath = path.join(__dirname, "src", "config", "tasas.json");
    const data = fs.readFileSync(filePath, "utf8");
    return res.json(JSON.parse(data));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ADMIN: ACTUALIZAR TASAS
app.post("/admin/tasas", async (req, res) => {
  try {
    const body = req.body || {};
    const nuevasTasas = {
      brl_cup: {
        faixas: [
          { min: 0, max: 99, tasa: 100 },
          { min: 100, max: 499, tasa: Number(body.brl1) },
          { min: 500, max: 999999, tasa: Number(body.brl2) }
        ]
      },
      usd_clasica: { tasa: Number(body.usd1) },
      usd_prepago: { tasa: Number(body.usd2) }
    };

    fs.writeFileSync(
      path.join(__dirname, "src", "config", "tasas.json"),
      JSON.stringify(nuevasTasas, null, 2)
    );

    return res.json({ success: true, message: "🔥 Tasas actualizadas" });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// HEALTH CHECK
app.get("/", (req, res) => {
  res.send("YordaBot Online");
});

// INICIO DEL SERVIDOR
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Servidor activo puerto " + PORT);
});

// --- CORRECCIÓN DE CIERRE DE PROCESOS ---
process.on("unhandledRejection", (err) => {
  logger("error", "UNHANDLED_REJECTION", { err: err?.message });
});

process.on("uncaughtException", (err) => {
  logger("error", "UNCAUGHT_EXCEPTION", { err: err?.message });
});
