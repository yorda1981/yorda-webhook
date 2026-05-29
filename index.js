const express = require("express");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

// ==========================================
// IMPORTS
// ==========================================
const openaiService = require("./src/services/openai");
const { obtenerTodos } = require("./src/services/customer-memory");
const { obtenerTodas } = require("./src/services/operations"); // ← NUEVO

const app = express();

// ==========================================
// CONFIGURAÇÃO INICIAL
// ==========================================
const PORT = process.env.PORT || 8080;
app.set("trust proxy", 1);

// ==========================================
// MEMÓRIA TEMPORÁRIA (BUFFER & COOLDOWN)
// ==========================================
const buffers = new Map();
const pendingMessages = new Map();
const lastResponses = new Map();

// ==========================================
// MIDDLEWARES
// ==========================================
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// RATE LIMITERS (Segurança)
// ==========================================
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    message: { error: "Demasiadas solicitações" }
});

const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: "Acesso restrito"
});

// ==========================================
// CAMINHOS & PROTEÇÃO
// ==========================================
const TASAS_PATH = path.join(__dirname, "src", "config", "tasas.json");

const verificarToken = (req, res, next) => {
    const token = req.headers["x-admin-token"] || req.query.token;
    const secret = process.env.ADMIN_TOKEN?.trim();

    if (!secret) {
        console.error("❌ ADMIN_TOKEN não definido no ENV");
        return res.status(500).send("<h1>Erro de configuração</h1>");
    }

    if (!token || token.trim() !== secret) {
        return res.status(401).json({ error: "Não autorizado" });
    }

    next();
};

// ==========================================
// WEBHOOK PRINCIPAL (LÓGICA 10/10)
// ==========================================
app.post("/webhook", webhookLimiter, async (req, res) => {
    res.status(200).send("OK");

    try {
        const body = req.body;

        if (!body || body.type !== "ReceivedCallback") return;
        if (body.fromMe === true || body.fromMe === "true") return;
        if (body.isGroup === true || body.isNewsletter === true) return;

        const phone = body.phone || body.from;
        const textMessage = body.text?.message || body.body || body.message || "";
        const pushName = body.senderName || body.sender?.pushName || "Cliente";

        if (!phone || !textMessage || typeof textMessage !== "string") return;

        // 1. ACUMULAÇÃO (Sempre ouve)
        const mensajeAnterior = pendingMessages.get(phone) || "";
        const mensajeAcumulado = mensajeAnterior
            ? mensajeAnterior + "\n" + textMessage
            : textMessage;

        pendingMessages.set(phone, mensajeAcumulado);
        console.log(`📩 Buffer acumulado (${phone}):\n${mensajeAcumulado}`);

        // 2. GESTÃO DO TIMER (3 SEGUNDOS)
        if (buffers.has(phone)) {
            clearTimeout(buffers.get(phone));
        }

        const timer = setTimeout(async () => {
            const mensajeParaEnviar = pendingMessages.get(phone);
            if (!mensajeParaEnviar) return;

            // 3. COOLDOWN DE ENVIO (Proteção de saída)
            const ultimaRespuesta = lastResponses.get(phone);
            if (ultimaRespuesta && Date.now() - ultimaRespuesta < 3000) {
                console.log("⏳ Cooldown activo: Aguardando para processar.");
                return;
            }

            try {
                console.log(`🧠 IA a trabalhar para ${phone}...`);
                const respuesta = await openaiService.procesarMensaje(
                    phone,
                    mensajeParaEnviar,
                    pushName
                );

                if (respuesta) {
                    lastResponses.set(phone, Date.now());
                    pendingMessages.delete(phone);
                    console.log(`✅ Ciclo concluído para ${phone}`);
                }
            } catch (e) {
                console.error(`❌ Erro OpenAI para ${phone} (Mensagem preservada):`, e.message);
            } finally {
                buffers.delete(phone);
            }
        }, 3000);

        buffers.set(phone, timer);

    } catch (e) {
        console.error("❌ Erro fatal no Webhook:", e);
    }
});

// ==========================================
// ROTAS ADMIN & STATS (CONEXÃO DASHBOARD)
// ==========================================

// Obtener Tasas
app.get("/admin/tasas", adminLimiter, verificarToken, (req, res) => {
    try {
        if (!fs.existsSync(TASAS_PATH)) return res.json({});
        const data = JSON.parse(fs.readFileSync(TASAS_PATH, "utf8"));
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Guardar Tasas
app.post("/admin/tasas", adminLimiter, verificarToken, async (req, res) => {
    try {
        await fs.promises.writeFile(TASAS_PATH, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Stats Globales
app.get("/admin/stats", adminLimiter, verificarToken, (req, res) => {
    try {
        const clientes = obtenerTodos();
        res.json({
            clientes: clientes.length,
            vip: clientes.filter(c => c.vip).length,
            operaciones: clientes.reduce((acc, c) => acc + (c.totalOperaciones || 0), 0),
            total: clientes.reduce((acc, c) => acc + (c.totalEnviado || 0), 0)
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lista de Clientes
app.get("/admin/clientes", adminLimiter, verificarToken, (req, res) => {
    try {
        res.json(obtenerTodos());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// OPERACIONES  ← NUEVO
// ==========================================
app.get("/admin/operaciones", adminLimiter, verificarToken, (req, res) => {
    try {
        res.json(obtenerTodas());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// ROTA: DASHBOARD
// ==========================================
app.get("/dashboard", adminLimiter, verificarToken, (req, res) => {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// ==========================================
// INICIALIZAÇÃO
// ==========================================
app.get("/", (req, res) => res.send("YordaBot Online ✅"));

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 SERVER UP NA PORTA ${PORT}`);
});

const shutdown = (signal) => {
    console.log(`${signal} recebido. Limpando buffers...`);
    for (const timer of buffers.values()) clearTimeout(timer);
    process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
