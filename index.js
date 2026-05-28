const express = require("express");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

// ==========================================
// IMPORTS (fuera del handler)
// ==========================================
const openaiService = require("./src/services/openai");

const app = express();

// ==========================================
// BUFFER ANTI-SPAM (debounce por usuario)
// ==========================================
// buffers:         timer activo por número
// pendingMessages: último mensaje recibido por número
//
// Flujo: usuario manda 3 mensajes en ráfaga →
//   cada nuevo mensaje cancela el timer anterior
//   y actualiza pendingMessages con el texto más reciente.
//   Tras 4s de silencio, se procesa SOLO el último.
const buffers         = new Map();
const pendingMessages = new Map();

// ==========================================
// MIDDLEWARES
// ==========================================
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// RATE LIMITING
// ==========================================
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 300,            // 300 req/min — cubre typing, receipts, retries y media callbacks de Z-API
  message: { error: "Demasiadas solicitudes. Intenta más tarde." },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 50,
  message: { error: "Demasiadas solicitudes admin." },
});

// ==========================================
// CONFIG
// ==========================================
const TASAS_PATH = path.join(__dirname, "src", "config", "tasas.json");

// ==========================================
// PROTECCIÓN ADMIN
// ==========================================
const verificarToken = (req, res, next) => {
  // Leer token solo desde header — más seguro que query param.
  // TODO: eliminar req.query.token cuando todos los clientes
  //       admin usen el header x-admin-token.
  const token  = req.headers["x-admin-token"] || req.query.token;
  const secret = process.env.ADMIN_TOKEN?.trim();

  if (!secret) {
    console.error("⚠️  ADMIN_TOKEN no está definido en .env");
    return res.status(500).send("<h1>Error de configuración del servidor</h1>");
  }

  if (!token || token.trim() !== secret) {
    return res.status(401).json({ error: "No autorizado" });
  }

  next();
};

// ==========================================
// WEBHOOK
// ==========================================
app.post("/webhook", webhookLimiter, async (req, res) => {
  // Respuesta inmediata a Z-API
  res.status(200).send("OK");

  try {
    const body = req.body;

    if (!body) return;

    // ==========================================
    // FILTRO Z-API — solo mensajes reales
    // ==========================================
    // Z-API también dispara callbacks de tipo delivered,
    // read, typing, ack, etc. Solo nos interesan los ReceivedCallback.
    if (body.type !== "ReceivedCallback") {
      console.log(`🔕 Callback ignorado: ${body.type || "sin tipo"}`);
      return;
    }

    // Ignorar mensajes propios
    if (body.fromMe === true || body.fromMe === "true") {
      console.log("🚫 Mensaje propio ignorado");
      return;
    }

    // Ignorar grupos y newsletters
    if (body.isGroup === true || body.isNewsletter === true) {
      console.log("🚫 Grupo/Newsletter ignorado");
      return;
    }

    const phone       = body.phone || body.from;
    const textMessage = body.text?.message || body.body;

    if (!phone || !textMessage) {
      console.log("⚠️ Mensaje inválido: falta phone o text");
      return;
    }

    if (typeof openaiService.procesarMensaje !== "function") {
      throw new Error("procesarMensaje no está exportado correctamente");
    }

    console.log(`📩 Mensaje de: ${body.senderName || phone}`);

    // ==========================================
    // BUFFER ANTI-SPAM — debounce 4s por usuario
    // ==========================================
    // Siempre guardar el texto MÁS RECIENTE antes de
    // (re)iniciar el timer — así el closure nunca queda
    // "congelado" con el primer mensaje de la ráfaga.
    pendingMessages.set(phone, textMessage);

    if (buffers.has(phone)) {
      clearTimeout(buffers.get(phone));
      console.log(`⏳ Buffer reiniciado para ${phone}`);
    }

    buffers.set(
      phone,
      setTimeout(async () => {
        // Leer el último mensaje actualizado, no el del closure
        const mensaje = pendingMessages.get(phone);
        try {
          console.log(`🤖 IA trabajando para ${phone}...`);
          await openaiService.procesarMensaje(phone, mensaje);
          console.log("✅ Respuesta enviada.");
        } catch (e) {
          console.error("💥 ERROR EN BUFFER:", e);
        } finally {
          buffers.delete(phone);
          pendingMessages.delete(phone);
        }
      }, 4000)
    );

  } catch (e) {
    console.error("💥 ERROR EN WEBHOOK:", e);
  }
});

// ==========================================
// ADMIN STATS
// ==========================================
app.get("/admin/stats", adminLimiter, verificarToken, async (req, res) => {
  try {
    // TODO: reemplazar con consulta real a la base de datos
    const stats = {
      clientes: 0,
      vip: 0,
      operaciones: 0,
      total: 0,
    };
    return res.json(stats);
  } catch (e) {
    console.error("Error en /admin/stats:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ==========================================
// GET TASAS
// ==========================================
app.get("/admin/tasas", adminLimiter, verificarToken, (req, res) => {
  try {
    if (!fs.existsSync(TASAS_PATH)) {
      return res.json({});
    }

    const data = JSON.parse(fs.readFileSync(TASAS_PATH, "utf8"));

    return res.json({
      brl_0:    data.brl_cup?.faixas?.[0]?.tasa || 0,
      brl_100:  data.brl_cup?.faixas?.[1]?.tasa || 0,
      brl_500:  data.brl_cup?.faixas?.[2]?.tasa || 0,
      brl_1000: data.brl_cup?.faixas?.[3]?.tasa || 0,
      usd1:     data.usd_clasica?.tasa || 0,
      usd2:     data.usd_prepago?.tasa || 0,
    });
  } catch (e) {
    console.error("Error en GET /admin/tasas:", e);
    return res.status(500).json({ error: e.message });
  }
});

// ==========================================
// POST TASAS
// ==========================================
app.post("/admin/tasas", adminLimiter, verificarToken, async (req, res) => {
  try {
    const { brl_0, brl_100, brl_500, brl_1000, usd1, usd2 } = req.body;

    // Validar que todos los campos existan y sean números válidos
    const campos = { brl_0, brl_100, brl_500, brl_1000, usd1, usd2 };
    for (const [nombre, valor] of Object.entries(campos)) {
      if (valor === undefined || valor === null || valor === "") {
        return res.status(400).json({ error: `Campo requerido: ${nombre}` });
      }
      if (isNaN(Number(valor)) || Number(valor) < 0) {
        return res.status(400).json({ error: `Valor inválido para: ${nombre}` });
      }
    }

    const nuevasTasas = {
      brl_cup: {
        faixas: [
          { min: 0,    max: 99,     tasa: Number(brl_0)    },
          { min: 100,  max: 499,    tasa: Number(brl_100)  },
          { min: 500,  max: 999,    tasa: Number(brl_500)  },
          { min: 1000, max: 999999, tasa: Number(brl_1000) },
        ],
      },
      usd_clasica: { tasa: Number(usd1) },
      usd_prepago: { tasa: Number(usd2) },
    };

    // Escritura asíncrona para no bloquear el event loop
    await fs.promises.writeFile(TASAS_PATH, JSON.stringify(nuevasTasas, null, 2));

    return res.json({ success: true });
  } catch (e) {
    console.error("Error en POST /admin/tasas:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================
// DASHBOARD
// ==========================================
app.get("/dashboard", adminLimiter, verificarToken, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// ==========================================
// HOME
// ==========================================
app.get("/", (req, res) => {
  res.send("YordaBot Online");
});

// ==========================================
// SERVER
// ==========================================
const PORT = process.env.PORT || 8080;

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ SERVER UP > Puerto ${PORT}`);
});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================
const shutdown = (signal) => {
  console.log(`\n${signal} recibido. Cerrando servidor...`);

  // Cancelar todos los buffers y mensajes pendientes antes de cerrar
  for (const [phone, timer] of buffers.entries()) {
    clearTimeout(timer);
    console.log(`🧹 Buffer cancelado para ${phone}`);
  }
  buffers.clear();
  pendingMessages.clear();

  server.close(() => {
    console.log("✅ Servidor cerrado correctamente.");
    process.exit(0);
  });

  // Forzar cierre si tarda más de 10 segundos
  setTimeout(() => {
    console.error("⚠️ Cierre forzado tras timeout.");
    process.exit(1);
  }, 10_000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
