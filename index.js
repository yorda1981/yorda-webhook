const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

const pool = require("./db");

// ==========================================
// SERVICIOS
// ==========================================

const openaiService = require("./src/services/openai");
const { obtenerTodos, obtenerCliente } = require("./src/services/customer-memory");
const { obtenerTodas, confirmarOperacion, obtenerEstadisticas } = require("./src/services/operations");

const app = express();
const PORT = process.env.PORT || 8080;

app.set("trust proxy", 1);

// ==========================================
// CONFIGURACIÓN Y MEMORIA
// ==========================================

const buffers = new Map();
const pendingMessages = new Map();
const pausasHumanas = new Map();
const mapaLidATelefono = new Map(); 
const mensajesProcesados = new Set();

const MINUTOS_PAUSA = 30;

// ==========================================
// FUNCIONES DE CONTROL
// ==========================================

function activarPausaHumana(phone) {
    if (!phone) return;

    if (!String(phone).startsWith("55")) {
        console.log(`⚠️ Pausa ignorada para ${phone} (No es un número válido de Brasil)`);
        return;
    }

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

// ==========================================
// WEBHOOK PRINCIPAL
// ==========================================

app.post("/webhook", async (req, res) => {
    res.status(200).send("OK");

    try {
        const body = req.body;
        if (!body) return;

        const phoneRaw = body.phone || body.from;

        // ✅ VINCULACIÓN PROTEGIDA: Solo mapear si el mensaje NO es mío
        if (
            body.chatLid &&
            body.phone &&
            body.phone.startsWith("55") &&
            !body.fromMe
        ) {
            mapaLidATelefono.set(body.chatLid, body.phone);
        }

        // ✅ FILTROS RÁPIDOS
        if (body.isGroup || String(phoneRaw).includes("-group")) return;
        if (body.isNewsletter) return;

        // ✅ DETECCIÓN DE MENSAJE MANUAL (Pausa Humana)
        if (body.fromMe) {
            if (body.fromApi !== true) {
                const telefonoCliente = mapaLidATelefono.get(body.chatLid);
                if (telefonoCliente) {
                    activarPausaHumana(telefonoCliente);
                }
            }
            return;
        }

        // Ignorar chats LID directos y números fuera de Brasil
        if (!phoneRaw || phoneRaw.includes("@lid")) return;
        if (!phoneRaw.startsWith("55")) return;

        const tiposValidos = ["ReceivedCallback", "image", "document", "audio", "video"];
        if (!tiposValidos.includes(body.type)) return;

        const messageId = body.messageId || body.id || body.zeId;
        if (messageId && mensajesProcesados.has(messageId)) return;
        if (messageId) {
            mensajesProcesados.add(messageId);
            setTimeout(() => mensajesProcesados.delete(messageId), 300000);
        }

        const pushName = body.senderName || "Cliente";

        // ✅ VERIFICAR SILENCIO DEL BOT
        if (enPausaHumana(phoneRaw)) {
            console.log(`🤫 BOT SILENCIADO PARA ${phoneRaw} (Pausa humana activa)`);
            return;
        }

        const esMultimedia =
            body.messageType === "image" ||
            body.messageType === "document" ||
            body.type === "image" ||
            body.type === "document" ||
            body.image ||
            body.document;

        const textMessage = body.text?.message || body.body || body.caption || "";

        // ==========================================
        // MANEJO DE MULTIMEDIA
        // ==========================================

        if (esMultimedia) {
            const mediaUrl = body.image?.imageUrl || body.document?.documentUrl || null;
            try {
                const cliente = await obtenerCliente(phoneRaw);
                if (
                    mediaUrl &&
                    (cliente?.estado === "aguardando_comprovante" || cliente?.estado === "cotizacion_realizada")
                ) {
                    await openaiService.procesarMensaje(phoneRaw, textMessage || "imagen_recibida", pushName, mediaUrl);
                }
            } catch (e) {
                console.error("❌ Error en multimedia:", e.message);
            }
            return;
        }

        // ==========================================
        // MANEJO DE MENSAJES DE TEXTO (Buffer 3.5s)
        // ==========================================

        if (!textMessage) return;

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
                console.error(`❌ Error OpenAI: ${e.message}`);
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
// RUTAS DE ADMINISTRACIÓN
// ==========================================

app.get("/admin/tasas", verificarToken, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM rates LIMIT 1");
        res.json(result.rows[0] || {});
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/tasas", verificarToken, async (req, res) => {
    try {
        const { brl_0, brl_100, brl_500, brl_1000, usd1, usd2 } = req.body;
        await pool.query(`UPDATE rates SET brl_0=$1, brl_100=$2, brl_500=$3, brl_1000=$4, usd1=$5, usd2=$6, updated_at=NOW() WHERE id=1`, 
        [brl_0, brl_100, brl_500, brl_1000, usd1, usd2]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/admin/clientes", verificarToken, async (req, res) => {
    try { res.json(await obtenerTodos()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/operaciones", verificarToken, async (req, res) => {
    try { res.json(await obtenerTodas()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/confirmar-operacion/:id", verificarToken, async (req, res) => {
    try {
        const operacion = await confirmarOperacion(req.params.id);
        if (!operacion) return res.status(404).json({ success: false, error: "Operación no encontrada" });
        try {
            await axios.post(`https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}/send-text`,
            { phone: operacion.phone, message: `✅ Pago confirmado.\n\nSu envío de R$${operacion.monto} ha sido aprobado.\n\nGracias.` },
            { headers: { "Client-Token": process.env.ZAPI_CLIENT_TOKEN } });
        } catch (err) { console.error("❌ Error enviando WhatsApp:", err.message); }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/dashboard", verificarToken, (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/", (req, res) => res.send("YordaBot Online ✅"));

app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
