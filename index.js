const express = require("express");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");

require("dotenv").config();

// ==========================================
// SERVICIOS
// ==========================================
const openaiService = require("./src/services/openai");
const { obtenerTodos } = require("./src/services/customer-memory");
// Fase 3: Importación de servicios de operaciones [cite: 33]
const { 
    obtenerTodas, 
    confirmarOperacion, 
    obtenerEstadisticas 
} = require("./src/services/operations");

const app = express();
const PORT = process.env.PORT || 8080; [cite: 3]
app.set("trust proxy", 1);

// ==========================================
// MEMORIA VOLÁTIL
// ==========================================
const buffers = new Map();
const pendingMessages = new Map(); [cite: 4]
const lastResponses = new Map();
const pausasHumanas = new Map();
const mapaNombresATelefono = new Map();
const mensajesProcesados = new Set(); [cite: 5]

const MINUTOS_PAUSA = 5; 

// ==========================================
// FUNCIONES DE CONTROL (OPTIMIZADA)
// ==========================================
function activarPausaHumana(phone) {
    const finActual = pausasHumanas.get(phone);
    if (finActual && finActual > Date.now()) { [cite: 6]
        console.log(`⏸️ Pausa ya activa para ${phone}. No se reinicia el tiempo.`);
        return; [cite: 7]
    }
    pausasHumanas.set(phone, Date.now() + (MINUTOS_PAUSA * 60 * 1000));
    console.log(`⏸️ Pausa humana activada por ${MINUTOS_PAUSA} min para ${phone}`); [cite: 8]
}

function enPausaHumana(phone) {
    const fin = pausasHumanas.get(phone);
    if (!fin) return false; [cite: 9]
    if (Date.now() > fin) {
        pausasHumanas.delete(phone);
        return false;
    } [cite: 10]
    return true;
}

// ==========================================
// MIDDLEWARES
// ==========================================
app.use(express.json({ limit: "10mb" })); [cite: 11]
app.use(express.static(path.join(__dirname, "public")));

const verificarToken = (req, res, next) => {
    const token = req.headers["x-admin-token"] || req.query.token;
    const secret = process.env.ADMIN_TOKEN?.trim(); [cite: 12]
    if (!token || token.trim() !== secret) return res.status(401).json({ error: "No autorizado" });
    next();
};

const TASAS_PATH = path.join(__dirname, "src", "config", "tasas.json"); [cite: 13]

// ==========================================
// WEBHOOK PRINCIPAL
// ==========================================
app.post("/webhook", async (req, res) => {
    res.status(200).send("OK");
    try {
        const body = req.body;
        if (!body || body.type !== "ReceivedCallback") return;

        const messageId = body.messageId || body.id || body.message?.id || body.zeId;
        if (messageId && mensajesProcesados.has(messageId)) return; [cite: 14]

        if (messageId) {
            mensajesProcesados.add(messageId);
            setTimeout(() => mensajesProcesados.delete(messageId), 300000); 
        }

        const chatName = body.chatName;
        const phoneRaw = body.phone || body.from;
        const textMessage = body.text?.message || body.body || body.message || ""; [cite: 15]
        const pushName = body.senderName || body.sender?.pushName || "Cliente";

        if (!body.fromMe && !body.isGroup && !body.isNewsletter && phoneRaw && chatName && !phoneRaw.includes("@lid")) { [cite: 16]
            if (!mapaNombresATelefono.has(chatName)) {
                mapaNombresATelefono.set(chatName, phoneRaw);
                console.log(`🔗 VÍNCULO CREADO: [${chatName}] -> ${phoneRaw}`); [cite: 17]
            }
        }

        if ((body.fromMe === true || body.fromMe === "true") && body.fromApi !== true) {
            const phoneReal = mapaNombresATelefono.get(chatName);
            if (phoneReal) activarPausaHumana(phoneReal); [cite: 18, 19]
            return; [cite: 20]
        }

        if (body.fromMe === true || body.fromMe === "true") return;
        if (body.isGroup === true || body.isNewsletter === true) return; [cite: 21]
        if (!phoneRaw || !textMessage || typeof textMessage !== "string") return;

        if (enPausaHumana(phoneRaw)) { [cite: 22]
            console.log(`⏸️ Bot silenciado por pausa humana: ${phoneRaw}`);
            return; [cite: 23]
        }

        const mensajeAnterior = pendingMessages.get(phoneRaw) || ""; [cite: 24]
        const mensajeAcumulado = mensajeAnterior ? mensajeAnterior + "\n" + textMessage : textMessage;
        pendingMessages.set(phoneRaw, mensajeAcumulado);

        if (buffers.has(phoneRaw)) clearTimeout(buffers.get(phoneRaw));
        const timer = setTimeout(async () => { [cite: 25]
            const mensajeParaEnviar = pendingMessages.get(phoneRaw);
            if (!mensajeParaEnviar) return;
            try {
                const respuesta = await openaiService.procesarMensaje(phoneRaw, mensajeParaEnviar, pushName);
                if (respuesta) {
                    lastResponses.set(phoneRaw, Date.now()); [cite: 26]
                    pendingMessages.delete(phoneRaw);
                }
            } catch (e) {
                console.error(`❌ Error OpenAI:`, e.message);
            } finally {
                buffers.delete(phoneRaw); [cite: 27]
            }
        }, 3000);
        buffers.set(phoneRaw, timer); [cite: 28]

    } catch (e) {
        console.error("❌ Error fatal en Webhook:", e);
    }
});

// ==========================================
// RUTAS ADMIN
// ==========================================
app.get("/admin/tasas", verificarToken, (req, res) => { [cite: 29]
    try {
        if (!fs.existsSync(TASAS_PATH)) return res.json({});
        res.json(JSON.parse(fs.readFileSync(TASAS_PATH, "utf8")));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/tasas", verificarToken, async (req, res) => { [cite: 30]
    try {
        await fs.promises.writeFile(TASAS_PATH, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/admin/clientes", verificarToken, (req, res) => { [cite: 31]
    try {
        res.json(obtenerTodos());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fase 3: Endpoints de Operaciones y Estadísticas Reales
app.get("/admin/operaciones", verificarToken, (req, res) => {
    try {
        res.json(obtenerTodas());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/admin/stats", verificarToken, (req, res) => {
    try {
        res.json(obtenerEstadisticas());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/admin/confirmar-operacion/:id", verificarToken, (req, res) => {
    try {
        const ok = confirmarOperacion(req.params.id);
        res.json({ success: ok });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get("/dashboard", verificarToken, (req, res) => { [cite: 32]
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/", (req, res) => res.send("YordaBot Online ✅"));

// ==========================================
// INICIO
// ==========================================
app.listen(PORT, "0.0.0.0", () => { [cite: 33]
    console.log(`🚀 YORDABOT UP EN PUERTO ${PORT}`);
});
