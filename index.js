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
const crm = require("./src/services/crm");
const { leerTasas } = require("./src/flows/cotizacion-flow");
const { enviarSeguro, getAdminPhone } = require("./src/flows/shared");

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

const buffers            = new Map();
const pendingMessages    = new Map();
const mapaLidATelefono   = new Map();
const mensajesProcesados = new Set();

const MINUTOS_PAUSA = 10;

// Migración segura: columna de tasa para envío de efectivo
(async () => {
    try {
        await pool.query("ALTER TABLE rates ADD COLUMN IF NOT EXISTS efectivo NUMERIC DEFAULT 0");
    } catch (e) { console.error("⚠️ Migración efectivo:", e.message); }
})();

// ─────────────────────────────────────────
// PAUSA HUMANA — persistida en PostgreSQL
// Sobrevive reinicios de Railway.
// Se activa cuando el operador escribe desde
// el WhatsApp directamente (fromMe + !fromApi).
// ─────────────────────────────────────────

async function activarPausaHumana(phone) {
    if (!phone) return;
    if (!String(phone).startsWith("55")) return;
    try {
        await pool.query(`
            UPDATE customers
            SET pausa_hasta = NOW() + ($1 * INTERVAL '1 minute'),
                updated_at  = NOW()
            WHERE phone = $2
        `, [MINUTOS_PAUSA, phone]);
        // Si el cliente aún no existe en DB, insertar fila mínima
        const r = await pool.query("SELECT phone FROM customers WHERE phone = $1", [phone]);
        if (r.rows.length === 0) {
            await pool.query(`
                INSERT INTO customers (phone, pausa_hasta, created_at, updated_at)
                VALUES ($1, NOW() + ($2 * INTERVAL '1 minute'), NOW(), NOW())
                ON CONFLICT (phone) DO NOTHING
            `, [phone, MINUTOS_PAUSA]);
        }
        console.log(`⏸️ Pausa humana (PG): ${MINUTOS_PAUSA} min → ${phone}`);
    } catch (e) {
        console.error("❌ activarPausaHumana:", e.message);
    }
}

async function enPausaHumana(phone) {
    if (!phone) return false;
    try {
        const r = await pool.query(
            "SELECT pausa_hasta FROM customers WHERE phone = $1",
            [phone]
        );
        if (!r.rows.length || !r.rows[0].pausa_hasta) return false;
        return new Date(r.rows[0].pausa_hasta) > new Date();
    } catch (e) {
        console.error("❌ enPausaHumana:", e.message);
        return false;   // ante la duda, dejar pasar al bot
    }
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
                if (telefonoCliente) await activarPausaHumana(telefonoCliente);
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

        if (await enPausaHumana(phoneRaw)) {
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
        const { brl_0, brl_100, brl_500, brl_1000, usd1, usd2, mlc, efectivo } = req.body;
        await pool.query(`
            UPDATE rates SET
                brl_0    = COALESCE($1, brl_0),
                brl_100  = COALESCE($2, brl_100),
                brl_500  = COALESCE($3, brl_500),
                brl_1000 = COALESCE($4, brl_1000),
                usd1     = COALESCE($5, usd1),
                usd2     = COALESCE($6, usd2),
                mlc      = COALESCE($7, mlc),
                efectivo = COALESCE($8, efectivo),
                updated_at = NOW()
            WHERE id = 1
        `, [brl_0, brl_100, brl_500, brl_1000, usd1, usd2, mlc, efectivo]);
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

app.get("/admin/crm/stats", adminLimiter, verificarToken, async (req, res) => {
    try { res.json(await crm.obtenerEstadisticasCRM()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/confirmar-operacion/:id", adminLimiter, verificarToken, async (req, res) => {
    try {
        const operacion = await confirmarOperacion(req.params.id);
        if (!operacion) return res.status(404).json({ success: false, error: "Operación no encontrada" });
        try {
            await axios.post(
                `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}/send-text`,
                { phone: operacion.phone, message: `✅ Recibimos su pago de R$${operacion.monto}.\n\nProcederemos a realizar la transferencia a Cuba.\n\nCuando se complete le enviaremos el comprobante. 😊` },
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

app.get("/api/tasas", async (req, res) => {
    try {
        const r = await pool.query("SELECT brl_0, brl_100, brl_500, brl_1000, usd1, mlc, efectivo FROM rates LIMIT 1");
        let oferta = null;
        try {
            const o = await pool.query("SELECT texto FROM ofertas WHERE activa = true AND (vence_at IS NULL OR vence_at > NOW()) LIMIT 1");
            oferta = o.rows[0]?.texto || null;
        } catch {}
        res.json({ ...(r.rows[0] || {}), oferta });
    } catch (e) { res.status(500).json({}); }
});

app.get("/", (req, res) => res.send("YordaBot Online ✅"));

app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));

// ══════════════════════════════════════
// CRM — RECORDATORIOS AUTOMÁTICOS
// Motor en src/services/crm.js
// 3 ondas: 30 min · 24 h · 7 días
// ══════════════════════════════════════

const { enviarMensaje } = require("./src/services/zapi");

// Migrar columnas CRM al arrancar (safe: IF NOT EXISTS)
crm.migrarColumnasCRM().catch(e => console.error("❌ CRM migración:", e.message));

// Ejecutar cada 15 minutos
setInterval(() => {
    crm.ejecutarRecordatorios().catch(e =>
        console.error("❌ CRM recordatorios:", e.message)
    );
}, 15 * 60 * 1000);

// ══════════════════════════════════════
// MENSAJE DIARIO DE TASAS (10:15 hora de Bahía = 13:15 UTC)
// El bot lo envía al ADMIN para que lo reenvíe a los grupos.
// ══════════════════════════════════════
const LINK_CALCULADORA = "https://yorda-webhook-production.up.railway.app/calculadora.html";
let ultimoEnvioTasas = ""; // evita reenvíos duplicados el mismo día

async function armarMensajeTasas() {
    const t = await leerTasas();
    if (!t) return null;
    const l = [];
    l.push("🔥 *TASAS YORDA — HOY* 🇧🇷→🇨🇺");
    l.push("");
    l.push("💵 *Reales → CUP*");
    if (t.brl_100)  l.push(`R$100+: *${Number(t.brl_100)} CUP*`);
    if (t.brl_500)  l.push(`R$500+: *${Number(t.brl_500)} CUP*`);
    if (t.brl_1000) l.push(`R$1000+: *${Number(t.brl_1000)} CUP*`);
    l.push("");
    if (Number(t.usd1) > 0)     l.push(`💳 USD tarjeta: *R$${Number(t.usd1)}*`);
    if (Number(t.mlc) > 0)      l.push(`🪪 MLC: *R$${Number(t.mlc)}*`);
    if (Number(t.efectivo) > 0) l.push(`💵 Efectivo: *${Number(t.efectivo)} CUP por real*`);
    l.push("");
    l.push("⚡ *Entrega el mismo día*");
    l.push("📍 La Habana y Granma");
    l.push("");
    l.push("🧮 Calcula tu envío aquí:");
    l.push(LINK_CALCULADORA);
    return l.join("\n");
}

async function enviarTasasDiarias() {
    const admin = getAdminPhone();
    if (!admin) { console.warn("⚠️ ADMIN_PHONE no configurado — no se envían tasas diarias"); return; }
    const msg = await armarMensajeTasas();
    if (!msg) { console.warn("⚠️ No hay tasas para el mensaje diario"); return; }
    await enviarSeguro(admin, msg);
    console.log("✅ Mensaje diario de tasas enviado al admin");
}

// Revisa cada minuto; dispara una sola vez cuando son las 13:15 UTC (10:15 Bahía)
setInterval(() => {
    const ahora = new Date();
    const hoyKey = ahora.toISOString().slice(0, 10); // AAAA-MM-DD (UTC)
    if (ahora.getUTCHours() === 13 && ahora.getUTCMinutes() === 15 && ultimoEnvioTasas !== hoyKey) {
        ultimoEnvioTasas = hoyKey;
        enviarTasasDiarias().catch(e => console.error("❌ Tasas diarias:", e.message));
    }
}, 60 * 1000);

// ══════════════════════════════════════
// NUEVO ENDPOINT CRM STATS
// ══════════════════════════════════════

// (ya registrado arriba junto a /admin/stats)
