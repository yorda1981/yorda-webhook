const express = require("express");
const fs = require("fs");
const path = require("path");

require("dotenv").config();

// ==========================================
// SERVICIOS
// ==========================================
const openaiService = require("./src/services/openai");
const { obtenerTodos } = require("./src/services/customer-memory");
const { 
    obtenerTodas, 
    confirmarOperacion, 
    obtenerEstadisticas 
} = require("./src/services/operations");

const app = express();
const PORT = process.env.PORT || 8080;
app.set("trust proxy", 1);

// ==========================================
// CONFIGURACIÓN Y MEMORIA
// ==========================================
const buffers = new Map();
const pendingMessages = new Map();
const pausasHumanas = new Map();
const mapaNombresATelefono = new Map();
const mensajesProcesados = new Set();

const MINUTOS_PAUSA = 30; 

// ==========================================
// FUNCIONES DE CONTROL
// ==========================================
function activarPausaHumana(phone) {
    const finActual = pausasHumanas.get(phone);
    if (finActual && finActual > Date.now()) return;
    pausasHumanas.set(phone, Date.now() + (MINUTOS_PAUSA * 60 * 1000));
    console.log(`⏸️ Pausa humana: ${MINUTOS_PAUSA} min para ${phone}`);
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

const verificarToken = (req, res, next) => {
    const token = req.headers["x-admin-token"] || req.query.token;
    const secret = process.env.ADMIN_TOKEN?.trim();
    if (!token || token.trim() !== secret) return res.status(401).json({ error: "No autorizado" });
    next();
};

const TASAS_PATH = path.join(__dirname, "src", "config", "tasas.json");

// ==========================================
// WEBHOOK PRINCIPAL (VERSIÓN ROBUSTA)
// ==========================================
app.post("/webhook", async (req, res) => {
    res.status(200).send("OK");
    try {
        const body = req.body;
        if (!body) return;

        // 🔍 AUDITORÍA DE WEBHOOK
        console.log("📥 WEBHOOK RECEIVED:", JSON.stringify({
            type: body.type,
            messageType: body.messageType,
            text: body.text?.message || body.body || "No text",
            hasImage: !!(body.image || body.type === "image" || body.messageType === "image"),
            hasDoc: !!(body.document || body.type === "document" || body.messageType === "document")
        }, null, 2));

        // Validación de entrada flexibilizada (Acepta disparos directos de multimedia)
        const tiposValidos = ["ReceivedCallback", "image", "document", "audio", "video"];
        if (!tiposValidos.includes(body.type)) return;

        // Evitar duplicados (messageId es el más fiable en Z-API)
        const messageId = body.messageId || body.id || body.zeId;
        if (messageId && mensajesProcesados.has(messageId)) return;
        if (messageId) {
            mensajesProcesados.add(messageId);
            setTimeout(() => mensajesProcesados.delete(messageId), 300000); 
        }

        const phoneRaw = body.phone || body.from;
        const chatName = body.chatName;
        const pushName = body.senderName || "Cliente";

        // Filtro DDD 55 (Solo Brasil)
        if (!phoneRaw || !phoneRaw.startsWith("55")) return;

        // Registro de salida humana (Pausa)
        if ((body.fromMe === true || body.fromMe === "true") && body.fromApi !== true) {
            if (!mapaNombresATelefono.has(chatName)) mapaNombresATelefono.set(chatName, phoneRaw);
            const phoneReal = mapaNombresATelefono.get(chatName);
            if (phoneReal) activarPausaHumana(phoneReal);
            return;
        }

        if (body.fromMe === true || body.isGroup || body.isNewsletter) return;
        if (enPausaHumana(phoneRaw)) return;

        // 🛠️ DETECCIÓN MULTIMEDIA ROBUSTA
        const esMultimedia = 
            body.messageType === "image" || 
            body.messageType === "document" || 
            body.type === "image" || 
            body.type === "document" || 
            body.image || 
            body.document;

        const textMessage = body.text?.message || body.body || body.caption || "";

        if (esMultimedia) {
            console.log(`📸 Multimedia (comprobante) de ${phoneRaw}. Caption: "${textMessage || 'comprobante'}"`);
            try {
                // Priorizamos el caption (subtítulo) para capturar montos escritos junto a la imagen
                await openaiService.procesarMensaje(phoneRaw, textMessage || "comprobante", pushName);
            } catch (e) {
                console.error("❌ Error en multimedia:", e.message);
            }
            return; 
        }

        if (!textMessage) return;

        // BUFFER DE TEXTO (Espera 3.5s para agrupar mensajes)
        const mensajeAnterior = pendingMessages.get(phoneRaw) || "";
        pendingMessages.set(phoneRaw, mensajeAnterior ? mensajeAnterior + "\n" + textMessage : textMessage);

        if (buffers.has(phoneRaw)) clearTimeout(buffers.get(phoneRaw));
        const timer = setTimeout(async () => {
            const msgFinal = pendingMessages.get(phoneRaw);
            if (!msgFinal) return;
            try {
                await openaiService.procesarMensaje(phoneRaw, msgFinal, pushName);
                pendingMessages.delete(phoneRaw);
            } catch (e) {
                console.error(`❌ Error OpenAI:`, e.message);
            } finally {
                buffers.delete(phoneRaw);
            }
        }, 3500); 
        buffers.set(phoneRaw, timer);

    } catch (e) {
        console.error("❌ Error en Webhook:", e);
    }
});

// ==========================================
// RUTAS ADMIN
// ==========================================
app.get("/admin/tasas", verificarToken, (req, res) => {
    try {
        if (!fs.existsSync(TASAS_PATH)) return res.json({});
        res.json(JSON.parse(fs.readFileSync(TASAS_PATH, "utf8")));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/tasas", verificarToken, async (req, res) => {
    try {
        await fs.promises.writeFile(TASAS_PATH, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/admin/clientes", verificarToken, (req, res) => {
    try { res.json(obtenerTodos()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/operaciones", verificarToken, (req, res) => {
    try { res.json(obtenerTodas()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/stats", verificarToken, (req, res) => {
    try { res.json(obtenerEstadisticas()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/confirmar-operacion/:id", verificarToken, (req, res) => {
    try {
        const ok = confirmarOperacion(req.params.id);
        res.json({ success: ok });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/dashboard", verificarToken, (req, res) => {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/", (req, res) => res.send("YordaBot Online ✅"));

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 SERVIDOR BLINDADO EN PUERTO ${PORT}`);
});
