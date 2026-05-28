const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();

// Configuración de Middlewares
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, "public")));

const TASAS_PATH = path.join(__dirname, "src", "config", "tasas.json");

// Middleware de Protección
const verificarToken = (req, res, next) => {
    const token = req.query.token;
    const secret = (process.env.ADMIN_TOKEN || "yorda123").trim();
    if (!token || token.trim() !== secret) {
        return res.status(401).send("<h1>🔒 No autorizado</h1>");
    }
    next();
};

// ==========================================
// WEBHOOK: EL CORAZÓN DEL BOT
// ==========================================
app.post("/webhook", async (req, res) => {
    // 1. Respuesta inmediata para Z-API
    res.status(200).send("OK");

    try {
        const body = req.body;
        if (!body || body.fromMe === true || body.fromMe === "true") return;

        console.log("📩 Mensaje de:", body.senderName || body.phone);

        // CORRECCIÓN AQUÍ: Importación más segura
        const openaiService = require("./src/services/openai");
        
        // Verificamos si la función existe antes de llamarla
        if (typeof openaiService.procesarMensaje !== 'function') {
            throw new Error("La función 'procesarMensaje' no está exportada correctamente en openai.js");
        }

        const phone = body.phone || body.from;
        const textMessage = body.text?.message || body.body;

        if (phone && textMessage) {
            console.log(`🤖 IA trabajando para ${phone}...`);
            // Llamada directa al método del objeto exportado
            await openaiService.procesarMensaje(phone, textMessage);
            console.log(`✅ Respuesta enviada.`);
        }

    } catch (e) {
        console.error("💥 ERROR EN WEBHOOK:");
        console.error(e); // Railway te mostrará el Stack Trace completo
    }
});

// ==========================================
// RUTAS ADMINISTRATIVAS
// ==========================================

app.get("/admin/stats", verificarToken, async (req, res) => {
    try {
        const memory = require("./src/services/customer-memory");
        const clientes = memory.obtenerTodos();
        let stats = { clientes: 0, vip: 0, operaciones: 0, total: 0 };
        
        // Si clientes es un Map o Objeto, procesamos...
        return res.json(stats);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/tasas", verificarToken, (req, res) => {
    try {
        if (!fs.existsSync(TASAS_PATH)) return res.json({});
        const data = JSON.parse(fs.readFileSync(TASAS_PATH, "utf8"));
        return res.json({
            brl_0: data.brl_cup?.faixas[0]?.tasa || 0,
            brl_100: data.brl_cup?.faixas[1]?.tasa || 0,
            brl_500: data.brl_cup?.faixas[2]?.tasa || 0,
            brl_1000: data.brl_cup?.faixas[3]?.tasa || 0,
            usd1: data.usd_clasica?.tasa || 0,
            usd2: data.usd_prepago?.tasa || 0
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/tasas", verificarToken, (req, res) => {
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

app.get("/dashboard", verificarToken, (req, res) => {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/", (req, res) => res.send("YordaBot Online"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ SERVER UP > Puerto ${PORT}`);
});
