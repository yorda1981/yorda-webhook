const express = require("express");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");

require("dotenv").config();

const openaiService = require("./src/services/openai");
const { obtenerTodos } = require("./src/services/customer-memory");

const app = express();
const PORT = process.env.PORT || 8080;
app.set("trust proxy", 1);

// ==========================================
// MEMORIA DE SEGUIMIENTO
// ==========================================
const buffers = new Map();
const pendingMessages = new Map();
const lastResponses = new Map();
const pausasHumanas = new Map();

// Mapa para vincular Nombre de Chat -> Teléfono Real
const mapaNombresATelefono = new Map();

const MINUTOS_PAUSA = 5; 

// ==========================================
// FUNCIONES DE CONTROL
// ==========================================
function activarPausaHumana(phone) {
    pausasHumanas.set(phone, Date.now() + (MINUTOS_PAUSA * 60 * 1000));
    console.log(`\u23F8\uFE0F Pausa humana activada por ${MINUTOS_PAUSA} min para ${phone}`);
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
// MIDDLEWARES & SEGURIDAD
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
// WEBHOOK PRINCIPAL (FILTRO DE GRUPOS REFINADO)
// ==========================================
app.post("/webhook", async (req, res) => {
    res.status(200).send("OK");

    try {
        const body = req.body;
        if (!body || body.type !== "ReceivedCallback") return;

        const chatName = body.chatName;
        const phoneRaw = body.phone || body.from;
        const textMessage = body.text?.message || body.body || body.message || "";
        const pushName = body.senderName || body.sender?.pushName || "Cliente";

        // 1. REGISTRO DE IDENTIDAD (Solo clientes reales, NO grupos/newsletters)
        if (
            !body.fromMe && 
            !body.isGroup && 
            !body.isNewsletter && 
            phoneRaw && 
            chatName && 
            !phoneRaw.includes("@lid")
        ) {
            mapaNombresATelefono.set(chatName, phoneRaw);
            console.log(`\uD83D\uDD17 V\u00CDNCULO CREADO: [${chatName}] -> ${phoneRaw}`);
        }

        // 2. DETECTAR INTERVENCIÓN HUMANA (Manejando el LID de Z-API)
        if ((body.fromMe === true || body.fromMe === "\u0074\u0072\u0075\u0065") && body.fromApi !== true) {
            
            // Recuperamos el teléfono real usando el nombre del chat
            const phoneReal = mapaNombresATelefono.get(chatName);
            
            console.log("\uD83D\uDC68\u200D\uD83D\uDCBC MENSAJE MANUAL DETECTADO:", JSON.stringify({
                chatName,
                phoneRecibido: phoneRaw,
                phoneRealVinculado: phoneReal || "No encontrado"
            }, null, 2));

            if (phoneReal) {
                activarPausaHumana(phoneReal);
            }
            return;
        }

        // 3. FILTROS BÁSICOS DE PROCESAMIENTO
        if (body.fromMe === true || body.fromMe === "\u0074\u0072\u0075\u0065") return;
        if (body.isGroup === true || body.isNewsletter === true) return;
        if (!phoneRaw || !textMessage || typeof textMessage !== "\u0073\u0074\u0072\u0069\u006E\u0067") return;

        // 4. VERIFICAR PAUSA HUMANA
        if (enPausaHumana(phoneRaw)) {
            console.log(`\u23F8\uFE0F Conversa en pausa humana (Bot callado): ${phoneRaw}`);
            return;
        }

        // --- Lógica de Buffer (Acumulación de mensajes) ---
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
                console.error(`\u274C Error OpenAI:`, e.message);
            } finally {
                buffers.delete(phoneRaw);
            }
        }, 3000);

        buffers.set(phoneRaw, timer);

    } catch (e) {
        console.error("\u274C Error fatal en Webhook:", e);
    }
});

// ==========================================
// RESTO DE RUTAS (ADMIN, DASHBOARD)
// ==========================================
app.get("/admin/tasas", verificarToken, (req, res) => {
    try {
        if (!fs.existsSync(TASAS_PATH)) return res.json({});
        res.json(JSON.parse(fs.readFileSync(TASAS_PATH, "\u0075\u0074\u0066\u0038")));
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

app.get("/", (req, res) => res.send("YordaBot Online \u2705"));

app.listen(PORT, "0.0.0.0", () => {
    console.log(`\uD83D\uDE80 SERVER UP EN PUERTO ${PORT}`);
});
