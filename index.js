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
// MIDDLEWARE DE PROTECCIÓN
// ==========================================
const verificarToken = (req, res, next) => {
    const token = req.query.token;
    const secret = (process.env.ADMIN_TOKEN || "yorda123").trim();
    if (!token || token.trim() !== secret) {
        return res.status(401).send("<h1>🔒 No autorizado</h1>");
    }
    next();
};

// ==========================================
// WEBHOOK (DEBUGGING MODE)
// ==========================================
app.post("/webhook", (req, res) => {
    // 1. RESPUESTA INMEDIATA
    res.sendStatus(200);

    // 2. LOG DE ENTRADA (Ver estructura de Z-API)
    console.log("📩 NUEVO EVENTO RECIBIDO:");
    console.log(JSON.stringify(req.body, null, 2));

    // 3. PROCESAMIENTO ASÍNCRONO
    (async () => {
        try {
            const body = req.body;
            if (!body) return console.log("⚠️ Webhook recibido sin body");
            if (body.fromMe === true || body.fromMe === "true") return;

            // Intentar cargar el servicio
            let procesarMensaje;
            try {
                const service = require("./src/services/openai");
                procesarMensaje = service.procesarMensaje;
            } catch (err) {
                console.log("❌ ERROR AL CARGAR './src/services/openai':");
                console.log(err); // Aquí veremos si falta un módulo o hay error de sintaxis
                return;
            }

            const phone = body.phone || (body.data && body.data.from) || body.from;
            const textMessage = body.text?.message || body.body || (body.data && body.data.body);

            if (phone && textMessage) {
                console.log(`🤖 Procesando para ${phone}: "${textMessage}"`);
                await procesarMensaje(phone, textMessage);
                console.log(`✅ Respuesta enviada con éxito a ${phone}`);
            } else {
                console.log("❓ No se detectó teléfono o mensaje en la estructura");
            }

        } catch (e) {
            console.log("💥 ERROR CRÍTICO EN EL FLUJO DEL WEBHOOK:");
            console.log(e); // Volcado completo del objeto de error (Stack Trace)
        }
    })();
});

// ==========================================
// API ADMINISTRATIVA
// ==========================================

app.get("/admin/stats", verificarToken, async (req, res) => {
    try {
        let stats = { clientes: 0, vip: 0, operaciones: 0, total: 0 };
        try {
            const { obtenerTodos } = require("./src/services/customer-memory");
            const clientes = obtenerTodos();
            const entries = clientes instanceof Map ? clientes.entries() : Object.entries(clientes);
            for (const [phone, data] of entries) {
                stats.clientes++;
                stats.operaciones += (data.totalOperaciones || 0);
                stats.total += (data.totalEnviado || 0);
                if (data.vip) stats.vip++;
            }
        } catch (err) { /* Silencioso para stats */ }
        return res.json(stats);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/tasas", verificarToken, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
        if (!fs.existsSync(TASAS_PATH)) return res.json({ brl_0:0, brl_100:0, brl_500:0, brl_1000:0, usd1:0, usd2:0 });
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

app.get("/dashboard", verificarToken, (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/", (req, res) => res.send("YordaBot Online"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ SERVER UP > Puerto ${PORT}`));
