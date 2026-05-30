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

const app = express();

// ==========================================
// CONFIGURAÇÃO INICIAL
// ==========================================
const PORT = process.env.PORT || 8080;
app.set("trust proxy", 1);

const buffers = new Map();
const pendingMessages = new Map();
const lastResponses = new Map();
const pausasHumanas = new Map();

const MINUTOS_PAUSA = 5; 

// ==========================================
// FUNCIONES DE PAUSA HUMANA
// ==========================================
function activarPausaHumana(phone) {
    pausasHumanas.set(phone, Date.now() + (MINUTOS_PAUSA * 60 * 1000));
    console.log(`⏸️ Pausa humana activada por ${MINUTOS_PAUSA} min para ${phone}`);
}

function enPausaHumana(phone) {
    const fin = pausasHumanas.get(phone);
    if (!fin) return false;

    if (Date.now() > fin) {
        pausasHumanas.delete(phone);
        return false;
    }
    return true;
}

// ==========================================
// MIDDLEWARES
// ==========================================
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

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

const TASAS_PATH = path.join(__dirname, "src", "config", "tasas.json");

const verificarToken = (req, res, next) => {
    const token = req.headers["x-admin-token"] || req.query.token;
    const secret = process.env.ADMIN_TOKEN?.trim();
    if (!token || token.trim() !== secret) {
        return res.status(401).json({ error: "Não autorizado" });
    }
    next();
};

// ==========================================
// WEBHOOK PRINCIPAL (CORREGIDO)
// ==========================================
app.post("/webhook", webhookLimiter, async (req, res) => {
    res.status(200).send("OK");

    try {
        const body = req.body;
        if (!body || body.type !== "ReceivedCallback") return;

        const phone = body.phone || body.from;
        const textMessage = body.text?.message || body.body || body.message || "";
        const pushName = body.senderName || body.sender?.pushName || "Cliente";

        // 👨‍💼 FILTRO DE INTERVENCIÓN HUMANA
        // Solo activa la pausa si el mensaje es de la cuenta (fromMe) 
        // Y NO fue enviado por la API (fromApi !== true)
        if ((body.fromMe === true || body.fromMe === "true") && body.fromApi !== true) {
            console.log(
                "👨‍💼 INTERVENCIÓN HUMANA DETECTADA:",
                JSON.stringify({ phone, textMessage }, null, 2)
            );

            if (phone) {
                activarPausaHumana(phone);
            }
            return;
        }

        // Ignorar si el mensaje es de la cuenta pero viene de la API (es el bot respondiendo)
        if (body.fromMe === true || body.fromMe === "true") return;

        if (body.isGroup === true || body.isNewsletter === true) return;
        if (!phone || !textMessage || typeof textMessage !== "string") return;

        // Verificar si la conversación está en pausa para el bot
        if (enPausaHumana(phone)) {
            console.log(`⏸️ Conversa ignorada (Pausa Humana Activa): ${phone}`);
            return;
        }

        // --- Lógica de Acumulación y Respuesta ---
        const mensajeAnterior = pendingMessages.get(phone) || "";
        const mensajeAcumulado = mensajeAnterior 
            ? mensajeAnterior + "\n" + textMessage 
            : textMessage;

        pendingMessages.set(phone, mensajeAcumulado);

        if (buffers.has(phone)) {
            clearTimeout(buffers.get(phone));
        }

        const timer = setTimeout(async () => {
            const mensajeParaEnviar = pendingMessages.get(phone);
            if (!mensajeParaEnviar) return;

            const ultimaRespuesta = lastResponses.get(phone);
            if (ultimaRespuesta && Date.now() - ultimaRespuesta < 3000) return;

            try {
                const respuesta = await openaiService.procesarMensaje(
                    phone,
                    mensajeParaEnviar,
                    pushName
                );

                if (respuesta) {
                    lastResponses.set(phone, Date.now());
                    pendingMessages.delete(phone);
                }
            } catch (e) {
                console.error(`❌ Erro OpenAI:`, e.message);
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
// ROTAS ADMIN
// ==========================================
app.get("/admin/tasas", adminLimiter, verificarToken, (req, res) => {
    try {
        if (!fs.existsSync(TASAS_PATH)) return res.json({});
        res.json(JSON.parse(fs.readFileSync(TASAS_PATH, "utf8")));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/tasas", adminLimiter, verificarToken, async (req, res) => {
    try {
        await fs.promises.writeFile(TASAS_PATH, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/admin/clientes", adminLimiter, verificarToken, (req, res) => {
    try {
        res.json(obtenerTodos());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/dashboard", adminLimiter, verificarToken, (req, res) => {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/", (req, res) => res.send("YordaBot Online ✅"));

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 SERVER UP NA PORTA ${PORT}`);
});
