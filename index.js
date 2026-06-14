const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const pool = require("./db");

const openaiService = require("./src/services/openai");
const { obtenerTodos, obtenerCliente } = require("./src/services/customer-memory");
const { obtenerTodas, confirmarOperacion, obtenerEstadisticas } = require("./src/services/operations");

const app = express();
const PORT = process.env.PORT || 8080;
app.set("trust proxy", 1);

const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests"
});

const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests"
});

const buffers          = new Map();
const pendingMessages  = new Map();
const pausasHumanas    = new Map();
const mapaLidATelefono = new Map();
const mensajesProcesados = new Set();

const MINUTOS_PAUSA = 10;

function activarPausaHumana(phone) {
    if (!phone) return;
    if (!String(phone).startsWith("55")) return;
    const finActual = pausasHumanas.get(phone);
    if (finActual && finActual > Date.now()) return;
    pausasHumanas.set(phone, Date.now() + (MINUTOS_PAUSA * 60 * 1000));
    console.log(`⏸️ Pausa humana: ${MINUTOS_PAUSA} min para ${phone}`);
}

function enPausaHumana(phone) {
    const fin = pausasHumanas.get(phone);
    if (!fin) return false;
    if (Date.now() > fin) { pausasHumanas.delete(phone); return false; }
    return true;
}

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const verificarToken = (req, res, next) => {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const secret = process.env.ADMIN_TOKEN?.trim();
    if (!token || token.trim() !== secret) return res.status(401).json({ error: "No autorizado" });
    next();
};

// ==========================================
// WEBHOOK
// ==========================================

app.post("/webhook", webhookLimiter, async (req, res) => {
    res.status(200).send("OK");
    try {
        const body = req.body;
        if (!body) return;

        const phoneRaw = body.phone || body.from;

        if (body.chatLid && body.phone && body.phone.startsWith("55") && !body.fromMe) {
            mapaLidATelefono.set(body.chatLid, body.phone);
        }

        if (body.isGroup || String(phoneRaw).includes("-group")) return;
        if (body.isNewsletter) return;

        if (body.fromMe) {
            if (body.fromApi !== true) {
                const telefonoCliente = mapaLidATelefono.get(body.chatLid);
                if (telefonoCliente) activarPausaHumana(telefonoCliente);
            }
            return;
        }

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

        if (enPausaHumana(phoneRaw)) {
            console.log(`🤫 BOT SILENCIADO PARA ${phoneRaw}`);
            return;
        }

        // Audio — responder que solo atendemos por texto
        const esAudio =
            body.messageType === "audio" ||
            body.messageType === "ptt"   ||
            body.type === "audio"        ||
            body.audio;

        if (esAudio) {
            const { enviarMensaje } = require("./src/services/zapi");
            await enviarMensaje(phoneRaw, "Hola 😊 Solo atendemos por mensaje de texto. ¿En qué te puedo ayudar?");
            return;
        }

        const esMultimedia =
            body.messageType === "image"    ||
            body.messageType === "document" ||
            body.type === "image"           ||
            body.type === "document"        ||
            body.image || body.document;

        const textMessage = body.text?.message || body.body || body.caption || "";

        if (esMultimedia) {
            const mediaUrl = body.image?.imageUrl || body.document?.documentUrl || null;
            try {
                if (mediaUrl) {
                    await openaiService.procesarMensaje(phoneRaw, textMessage || "imagen_recibida", pushName, mediaUrl);
                }
            } catch (e) {
                console.error("❌ Error en multimedia:", e.message);
            }
            return;
        }

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
// ADMIN
// ==========================================

app.get("/admin/tasas", adminLimiter, verificarToken, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM rates LIMIT 1");
        res.json(result.rows[0] || {});
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/tasas", adminLimiter, verificarToken, async (req, res) => {
    try {
        const { brl_0, brl_100, brl_500, brl_1000, usd1, usd2 } = req.body;
        await pool.query(`
            UPDATE rates SET
                brl_0    = COALESCE($1, brl_0),
                brl_100  = COALESCE($2, brl_100),
                brl_500  = COALESCE($3, brl_500),
                brl_1000 = COALESCE($4, brl_1000),
                usd1     = COALESCE($5, usd1),
                usd2     = COALESCE($6, usd2),
                updated_at = NOW()
            WHERE id = 1
        `, [brl_0, brl_100, brl_500, brl_1000, usd1, usd2]);
        res.json({ success: true });
    } catch (e) {
        console.error("❌ ERROR TASAS:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get("/admin/clientes", adminLimiter, verificarToken, async (req, res) => {
    try { res.json(await obtenerTodos()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/operaciones", adminLimiter, verificarToken, async (req, res) => {
    try { res.json(await obtenerTodas()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/stats", adminLimiter, verificarToken, async (req, res) => {
    try { res.json(await obtenerEstadisticas()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/confirmar-operacion/:id", adminLimiter, verificarToken, async (req, res) => {
    try {
        const operacion = await confirmarOperacion(req.params.id);
        if (!operacion) return res.status(404).json({ success: false, error: "Operación no encontrada" });
        try {
            await axios.post(
                `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}/send-text`,
                { phone: operacion.phone, message: `✅ Pago confirmado.\n\nSu envío de R$${operacion.monto} ha sido aprobado.\n\nGracias.` },
                { headers: { "Client-Token": process.env.ZAPI_CLIENT_TOKEN } }
            );
        } catch (err) {
            console.error("❌ Error enviando WhatsApp:", err.message);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get("/dashboard", (req, res) =>
    res.sendFile(path.join(__dirname, "public", "dashboard.html"))
);

// Recargas
app.get("/admin/recargas", adminLimiter, verificarToken, async (req, res) => {
    try {
        const r = await pool.query("SELECT * FROM recargas ORDER BY tipo");
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/recargas/:tipo", adminLimiter, verificarToken, async (req, res) => {
    try {
        const { precio, descripcion, activa } = req.body;
        await pool.query(`
            UPDATE recargas SET
                precio = $1,
                descripcion = $2,
                activa = $3,
                updated_at = NOW()
            WHERE tipo = $4
        `, [precio, descripcion, activa, req.params.tipo]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Oferta del día
app.get("/admin/oferta", adminLimiter, verificarToken, async (req, res) => {
    try {
        const r = await pool.query("SELECT * FROM ofertas LIMIT 1");
        res.json(r.rows[0] || {});
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/oferta", adminLimiter, verificarToken, async (req, res) => {
    try {
        const { texto, activa, vence_at } = req.body;
        await pool.query(`
            UPDATE ofertas SET
                texto = $1,
                activa = $2,
                vence_at = $3,
                updated_at = NOW()
            WHERE id = 1
        `, [texto, activa, vence_at || null]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/", (req, res) => res.send("YordaBot Online ✅"));

app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));

// ══════════════════════════════════════
// RECORDATORIO AUTOMÁTICO
// Cada 30 minutos busca clientes que
// cotizaron hace más de 1 hora y no pagaron
// ══════════════════════════════════════

const { enviarMensaje } = require("./src/services/zapi");

async function enviarRecordatorios() {
    try {
        // Clientes con cotización realizada hace entre 1 y 3 horas sin pagar
        const result = await pool.query(`
            SELECT phone, nombre, ultimo_monto, tipo_favorito
            FROM customers
            WHERE estado = 'cotizacion_realizada'
            AND fecha_cotizacion < NOW() - INTERVAL '1 hour'
            AND fecha_cotizacion > NOW() - INTERVAL '3 hours'
            AND ultima_interaccion < NOW() - INTERVAL '1 hour'
        `);

        for (const cliente of result.rows) {
            try {
                const msg = `Hola ${cliente.nombre ? cliente.nombre.split(" ")[0] : ""} 😊

¿Pudiste hacer el pago de R$${cliente.ultimo_monto}?

Si tienes alguna duda estoy aquí para ayudarte. 👌`;
                await enviarMensaje(cliente.phone, msg);
                console.log(`🔔 Recordatorio enviado: ${cliente.phone}`);
                // Marcar que ya se envió recordatorio limpiando el estado
                await pool.query(
                    "UPDATE customers SET estado = 'recordatorio_enviado' WHERE phone = $1",
                    [cliente.phone]
                );
            } catch (e) {
                console.error(`❌ Error enviando recordatorio a ${cliente.phone}:`, e.message);
            }
        }
    } catch (e) {
        console.error("❌ Error en recordatorios:", e.message);
    }
}

// Ejecutar cada 30 minutos
setInterval(enviarRecordatorios, 30 * 60 * 1000);
