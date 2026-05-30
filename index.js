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

const app = express();
const PORT = process.env.PORT || 8080;
app.set("trust proxy", 1);

// ==========================================
// MEMORIA VOLÁTIL
// ==========================================
const buffers = new Map();
const pendingMessages = new Map();
const lastResponses = new Map();
const pausasHumanas = new Map();
const mapaNombresATelefono = new Map();
const mensajesProcesados = new Set(); 

const MINUTOS_PAUSA = 5; 

// ==========================================
// FUNCIONES DE CONTROL
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

const verificarToken = (req, res, next) => {
    const token = req.headers["x-admin-token"] || req.query.token;
    const secret = process.env.ADMIN_TOKEN?.trim();
    if (!token || token.trim() !== secret) return res.status(401).json({ error: "No autorizado" });
    next();
};

const TASAS_PATH = path.join(__dirname, "src", "config", "tasas.json");

// ==========================================
// WEBHOOK PRINCIPAL (LÓGICA BLINDADA)
// ==========================================
app.post("/webhook", async (req, res) => {
    res.status(200).send("OK");

    try {
        const body = req.body;
        if (!body || body.type !== "ReceivedCallback") return;

        // 🔍 1. CAPTURA Y AUDITORÍA DE IDs (Anti-duplicados)
        const messageId = body.messageId || body.id || body.message?.id || body.zeId;
        
        console.log("🔍 DEBUG IDs:", { 
            messageId, 
            rawId: body.id, 
            zeId: body.zeId,
            msgIdInternal: body.message?.id 
        });

        if (messageId && mensajesProcesados.has(messageId)) {
            console.log(`🚫 Duplicado bloqueado: ${messageId}`);
            return;
        }

        if (messageId) {
            mensajesProcesados.add(messageId);
            // Retención de 5 minutos contra reintentos de red
            setTimeout(() => mensajesProcesados.delete(messageId), 300000); 
        }

        const chatName = body.chatName;
        const phoneRaw = body.phone || body.from;
        const textMessage = body.text?.message || body.body || body.message || "";
        const pushName = body.senderName || body.sender?.pushName || "Cliente";

        // 2. VÍNCULO DE IDENTIDAD (ChatName -> Phone)
        // Solo para mensajes entrantes de clientes reales (no grupos/lid)
        if (
            !body.fromMe && 
            !body.isGroup && 
            !body.isNewsletter && 
            phoneRaw && 
            chatName && 
            !phoneRaw.includes("@lid")
        ) {
            if (!mapaNombresATelefono.has(chatName)) {
                mapaNombresATelefono.set(chatName, phoneRaw);
                console.log(`🔗 VÍNCULO CREADO: [${chatName}] -> ${phoneRaw}`);
            }
        }

        // 3. DETECTAR INTERVENCIÓN HUMANA (Manual desde App/Web)
        if ((body.fromMe === true || body.fromMe === "true") && body.fromApi !== true) {
            const phoneReal = mapaNombresATelefono.get(chatName);
            
            console.log("👨‍💼 INTERVENCIÓN MANUAL:", JSON.stringify({
                chatName,
                phoneReal: phoneReal || "Sin vínculo previo"
            }, null, 2));

            if (phoneReal) {
                activarPausaHumana(phoneReal);
            }
            return;
        }

        // 4. FILTROS BÁSICOS
        if (body.fromMe === true || body.fromMe === "true") return;
        if (body.isGroup === true || body.isNewsletter === true) return;
        if (!phoneRaw || !textMessage || typeof textMessage !== "string") return;

        // 5. VERIFICAR PAUSA HUMANA
        if (enPausaHumana(phoneRaw)) {
            console.log(`\u23F8\uFE0F Bot silenciado por pausa humana: ${phoneRaw}`);
            return;
        }

        // 6. GESTIÓN DE BUFFER (Acumulación)
        const mensajeAnterior = pendingMessages.get(phoneRaw) || "";
        const mensajeAcumulado = mensajeAnterior ? mensajeAnterior + "\n" + textMessage : textMessage;
        pendingMessages.set(phoneRaw, mensajeAcumulado);

        if (buffers.has(phoneRaw)) clearTimeout(buffers.get(phoneRaw));

        const timer = setTimeout(async () => {
            const mensajeParaEnviar = pendingMessages.get(phoneRaw);
            if (!mensajeParaEnviar) return;

            try {
                const respuesta = await openaiService.procesarMensaje(phoneRaw, mensajeParaEnviar, pushName);
                if (respuesta) {
                    lastResponses.set(phoneRaw, Date.now());
                    pendingMessages.delete(phoneRaw);
                }
            } catch (e) {
                console.error(`❌ Error OpenAI:`, e.message);
            } finally {
                buffers.delete(phoneRaw);
            }
        }, 3000);

        buffers.set(phoneRaw, timer);

    } catch (e) {
        console.error("❌ Error fatal en Webhook:", e);
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
    try {
        res.json(obtenerTodos());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/dashboard", verificarToken, (req, res) => {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/", (req, res) => res.send("YordaBot Online ✅"));

// ==========================================
// INICIO
// ==========================================
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 YORDABOT UP EN PUERTO ${PORT}`);
});
