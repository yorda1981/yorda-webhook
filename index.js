const express = require("express");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();

// ==========================================
// CONFIGURACIÓN DE SEGURIDAD Y ESTÁTICOS
// ==========================================
app.use(express.json({ limit: "10mb" }));
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Servir la carpeta public (donde están dashboard.html y style.css)
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// SERVICIOS CORE
// ==========================================
const redis = require("./src/services/redis");
const { procesarMensaje } = require("./src/services/openai");
const logger = require("./src/utils/logger");
const { detectarIntencion } = require("./src/engines/intent-engine");

// Rate limit para proteger contra ataques
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

const mensajesProcesados = new Set();
const humanTakeover = {};
const buffers = {};

// Limpieza de duplicados cada 30 min
setInterval(() => mensajesProcesados.clear(), 1000 * 60 * 30);

// ==========================================
// RUTAS DE NAVEGACIÓN
// ==========================================

// Health check para Railway/Render
app.get("/", (req, res) => {
    res.send("YordaBot Online");
});

// RUTA OFICIAL DEL DASHBOARD
console.log("🔥 CONFIGURANDO ROTA /dashboard...");
app.get("/dashboard", (req, res) => {
    const filePath = path.join(__dirname, "public", "dashboard.html");
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send("🚨 Error: No se encontró public/dashboard.html en el servidor.");
    }
});

// ==========================================
// WEBHOOK (WHATSAPP)
// ==========================================
app.post("/webhook", async (req, res) => {
    try {
        const body = req.body || {};
        const messageId = body.messageId || body.id || "";

        if (mensajesProcesados.has(messageId)) return res.sendStatus(200);
        if (messageId) mensajesProcesados.add(messageId);

        const fromMe = body.fromMe === true || body.fromMe === "true";
        const isGroup = body.isGroup === true || body.isGroup === "true";
        const phone = String(body.phone || body.chatId || body.from || "").replace(/\D/g, "");

        const textMessage = String(
            body.text?.message || body.message?.conversation || 
            body.message?.extendedTextMessage?.text || body.body || ""
        ).trim();

        if (!phone || !textMessage || isGroup) return res.sendStatus(200);

        // Bloqueo por intervención humana
        if (fromMe) {
            humanTakeover[phone] = Date.now();
            if (redis) await redis.set("ctx:" + phone, JSON.stringify({ humano: true }), "EX", 1800);
            return res.sendStatus(200);
        }

        // Filtro de intención de negocio
        if (!detectarIntencion(textMessage)) return res.sendStatus(200);

        // Buffer de mensajes (agrupación inteligente)
        if (!buffers[phone]) buffers[phone] = { textos: [], timeout: null };
        buffers[phone].textos.push(textMessage);
        clearTimeout(buffers[phone].timeout);

        buffers[phone].timeout = setTimeout(async () => {
            try {
                const finalMessage = buffers[phone].textos.join("\n");
                delete buffers[phone];
                await procesarMensaje(phone, finalMessage);
            } catch (e) { logger("error", "BUFFER_ERR", { err: e.message }); }
        }, 1500);

        return res.sendStatus(200);
    } catch (e) { return res.sendStatus(200); }
});

// ==========================================
// API ADMINISTRATIVA (Sincronizada con el Panel)
// ==========================================

// Obtener estadísticas reales
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
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// Obtener las 4 escalas de BRL y los 2 USD
app.get("/admin/tasas", async (req, res) => {
    try {
        const filePath = path.join(__dirname, "src", "config", "tasas.json");
        const data = fs.readFileSync(filePath, "utf8");
        const json = JSON.parse(data);
        
        return res.json({
            brl_0:    json.brl_cup?.faixas[0]?.tasa || 0,
            brl_100:  json.brl_cup?.faixas[1]?.tasa || 0,
            brl_500:  json.brl_cup?.faixas[2]?.tasa || 0,
            brl_1000: json.brl_cup?.faixas[3]?.tasa || 0,
            usd1:     json.usd_clasica?.tasa || 0,
            usd2:     json.usd_prepago?.tasa || 0
        });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// Guardar las 4 escalas enviadas desde el dashboard
app.post("/admin/tasas", async (req, res) => {
    try {
        const { brl_0, brl_100, brl_500, brl_1000, usd1, usd2 } = req.body;
        const nuevasTasas = {
            brl_cup: {
                faixas: [
                    { min: 0,    max: 99,     tasa: Number(brl_0) },
                    { min: 100,  max: 499,    tasa: Number(brl_100) },
                    { min: 500,  max: 999,    tasa: Number(brl_500) },
                    { min: 1000, max: 999999, tasa: Number(brl_1000) }
                ]
            },
            usd_clasica: { tasa: Number(usd1) },
            usd_prepago: { tasa: Number(usd2) }
        };
        const filePath = path.join(__dirname, "src", "config", "tasas.json");
        fs.writeFileSync(filePath, JSON.stringify(nuevasTasas, null, 2));
        return res.json({ success: true });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

// ==========================================
// ARRANQUE DEL SERVIDOR
// ==========================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
    console.log("✅ YordaBot Server activo en puerto " + PORT);
});

// Manejo de errores globales para evitar caídas
process.on("unhandledRejection", (err) => logger("error", "REJECTION", { err: err?.message }));
process.on("uncaughtException", (err) => logger("error", "EXCEPTION", { err: err?.message }));
