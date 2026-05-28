const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();

// ==========================================
// CONFIGURACIONES CORE
// ==========================================
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const TASAS_PATH = path.join(__dirname, "src", "config", "tasas.json");

// ==========================================
// PROTECCIÓN DEL DASHBOARD
// ==========================================
app.use("/dashboard", (req, res, next) => {
    const token = req.query.token;
    const secret = (process.env.ADMIN_TOKEN || "yorda123").trim();
    if (!token || token.trim() !== secret) {
        return res.status(401).send("<h1>🔒 No autorizado</h1>");
    }
    next();
});

// Middleware de protección para las APIs (usado por el Dashboard)
const verificarTokenApi = (req, res, next) => {
    const token = req.query.token;
    const secret = (process.env.ADMIN_TOKEN || "yorda123").trim();
    if (!token || token.trim() !== secret) return res.status(401).json({ error: "Unauthorized" });
    next();
};

// ==========================================
// WEBHOOK (RESPUESTA INMEDIATA)
// ==========================================
app.post("/webhook", (req, res) => {
    // 1. RESPUESTA INSTANTÁNEA A Z-API
    res.sendStatus(200);

    // 2. LÓGICA PESADA EN BACKGROUND
    (async () => {
        try {
            const body = req.body;
            if (!body || body.fromMe) return; // Evitar bucles

            const { procesarMensaje } = require("./src/services/openai");
            const phone = body.phone || body.from;
            const text = body.text?.message || body.body;

            if (phone && text) {
                // Aquí el bot se toma su tiempo con OpenAI
                await procesarMensaje(phone, text);
            }
        } catch (e) {
            console.error("❌ Error en background del webhook:", e.message);
        }
    })();
});

// ==========================================
// API ADMINISTRATIVA (DASHBOARD)
// ==========================================

app.get("/admin/stats", verificarTokenApi, async (req, res) => {
    try {
        let stats = { clientes: 0, vip: 0, operaciones: 0, total: 0 };
        try {
            const { obtenerTodos } = require("./src/services/customer-memory");
            const clientes = obtenerTodos();
            const entries = clientes instanceof Map ? clientes : Object.entries(clientes);
            for (const [phone, data] of entries) {
                stats.clientes++;
                stats.operaciones += (data.totalOperaciones || 0);
                stats.total += (data.totalEnviado || 0);
                if (data.vip) stats.vip++;
            }
        } catch (err) { /* Memoria no conectada */ }
        return res.json(stats);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/tasas", verificarTokenApi, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
        if (!fs.existsSync(TASAS_PATH)) return res.json({});
        const json = JSON.parse(fs.readFileSync(TASAS_PATH, "utf8"));
        return res.json({
            brl_0: json.brl_cup?.faixas[0]?.tasa || 0,
            brl_100: json.brl_cup?.faixas[1]?.tasa || 0,
            brl_500: json.brl_cup?.faixas[2]?.tasa || 0,
            brl_1000: json.brl_cup?.faixas[3]?.tasa || 0,
            usd1: json.usd_clasica?.tasa || 0,
            usd2: json.usd_prepago?.tasa || 0
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/tasas", verificarTokenApi, (req, res) => {
    try {
        const { brl_0, brl_100, brl_500, brl_1000, usd1, usd2 } = req.body;
        const nuevasTasas = {
            brl_cup: {
                faixas: [
                    { min: 0, max: 99, tasa: Number(brl_0) },
                    { min: 100, max: 499, tasa: Number(brl_100) },
                    { min: 500, max: 999, tasa: Number(brl_500) },
                    { min: 1000, max: 999999, tasa: Number(brl_1000) }
                ]
            },
            usd_clasica: { tasa: Number(usd1) },
            usd_prepago: { tasa: Number(usd2) }
        };
        fs.writeFileSync(TASAS_PATH, JSON.stringify(nuevasTasas, null, 2));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Navegación base
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/", (req, res) => res.send("YordaBot Online"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ SERVER UP > Puerto ${PORT}`));
