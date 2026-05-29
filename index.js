const express = require("express");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");

require("dotenv").config();

// ==========================================
// IMPORTS
// ==========================================
const openaiService = require("./src/services/openai");
const { obtenerPromo, guardarPromo } = require("./src/services/promo");

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
// RATE LIMITING (SEGURANÇA WEBHOOK)
// ==========================================
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    message: { error: "Demasiadas solicitações" }
});

// ==========================================
// CONFIGURAÇÃO DE CAMINHOS
// ==========================================
const TASAS_PATH = path.join(__dirname, "src", "config", "tasas.json");

// ==========================================
// PROTEÇÃO ADMIN (TOKEN)
// ==========================================
const verificarToken = (req, res, next) => {
    const token = req.headers["x-admin-token"] || req.query.token;
    const secret = process.env.ADMIN_TOKEN?.trim();

    if (!secret) {
        console.error("❌ ADMIN_TOKEN não definido no ENV");
        return res.status(500).send("<h1>Erro de configuração no servidor</h1>");
    }

    if (!token || token.trim() !== secret) {
        return res.status(401).json({ error: "Não autorizado" });
    }
    next();
};

// ==========================================
// WEBHOOK PRINCIPAL (LÓGICA 10/10 - RESILIENTE)
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

        // 1. ACUMULAÇÃO
        const mensajeAnterior = pendingMessages.get(phone) || "";
        const mensajeAcumulado = mensajeAnterior 
            ? mensajeAnterior + "\n" + textMessage 
            : textMessage;

        pendingMessages.set(phone, mensajeAcumulado);
        console.log(`📩 Buffer acumulado (${phone}):\n${mensajeAcumulado}`);

        // 2. GESTÃO DO TIMER
        if (buffers.has(phone)) {
            clearTimeout(buffers.get(phone));
        }

        const timer = setTimeout(async () => {
            const mensajeParaEnviar = pendingMessages.get(phone);
            if (!mensajeParaEnviar) return;

            // 3. COOLDOWN
            const ultimaRespuesta = lastResponses.get(phone);
            if (ultimaRespuesta && Date.now() - ultimaRespuesta < 3000) {
                console.log("⏳ Cooldown activo: Aguardando janela de resposta.");
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
                    console.log(`✅ Ciclo concluído com sucesso para ${phone}`);
                }

            } catch (e) {
                console.error(`❌ Erro OpenAI para ${phone}:`, e.message);
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
// ROTAS ADMIN (TASAS & PROMO)
// ==========================================
app.get("/admin/tasas", verificarToken, (req, res) => {
    try {
        if (!fs.existsSync(TASAS_PATH)) return res.json({});
        const data = JSON.parse(fs.readFileSync(TASAS_PATH, "utf8"));
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/admin/tasas", verificarToken, async (req, res) => {
    try {
        await fs.promises.writeFile(TASAS_PATH, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// DASHBOARD (NOVA ROTA)
// ==========================================
app.get("/dashboard", verificarToken, (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "dashboard.html")
    );
});

// ==========================================
// INICIALIZAÇÃO
// ==========================================
app.get("/", (req, res) => res.send("YordaBot Online ✅"));

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 SERVER UP NA PORTA ${PORT}`);
});

const shutdown = (signal) => {
    console.log(`${signal} recebido. A limpar buffers...`);
    for (const timer of buffers.values()) clearTimeout(timer);
    process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
