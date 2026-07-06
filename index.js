const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const pool = require("./db");

const openaiService = require("./src/services/openai");

// ─────────────────────────────────────────
// AUDITORÍA — registrar acciones del admin
// ─────────────────────────────────────────
async function registrarAuditoria(accion, req, detalle = null, phone = null) {
    try {
        const ip = req?.ip || req?.headers?.["x-forwarded-for"] || "unknown";
        await pool.query(
            "INSERT INTO audit_logs (accion, operador, detalle, phone) VALUES ($1, $2, $3, $4)",
            [accion, ip, detalle ? JSON.stringify(detalle) : null, phone || null]
        );
    } catch (e) {
        console.warn("⚠️ Auditoría:", e.message);
    }
}
const { obtenerTodos, obtenerCliente } = require("./src/services/customer-memory");
const { obtenerTodas, confirmarOperacion, obtenerEstadisticas } = require("./src/services/operations");
const crm         = require("./src/services/crm");
const memoryMotor = require("./src/services/memory-motor");

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

        // Ignorar mensajes editados — Z-API los reenvía como nuevos webhooks
        // pero el cliente ya los procesó antes
        if (body.isEdit || body.edited || body.messageStubType === "REVOKE" ||
            body.type === "edited_message" || body.updateType === "edit") {
            console.log(`✏️ Mensaje editado ignorado: ${phoneRaw}`);
            return;
        }

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
        const { brl_0, brl_100, brl_500, brl_1000, usd1, usd2, mlc } = req.body;
        await pool.query(`
            UPDATE rates SET
                brl_0    = COALESCE($1, brl_0),
                brl_100  = COALESCE($2, brl_100),
                brl_500  = COALESCE($3, brl_500),
                brl_1000 = COALESCE($4, brl_1000),
                usd1     = COALESCE($5, usd1),
                usd2     = COALESCE($6, usd2),
                mlc      = COALESCE($7, mlc),
                updated_at = NOW()
            WHERE id = 1
        `, [brl_0, brl_100, brl_500, brl_1000, usd1, usd2, mlc]);
        await registrarAuditoria("cambiar_tasas", req, { brl_0, brl_100, brl_500, brl_1000, usd1, usd2, mlc });
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

app.get("/admin/motor/stats", adminLimiter, verificarToken, async (req, res) => {
    try { res.json(await memoryMotor.obtenerEstadisticasMotor()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/motor/perfil/:phone", adminLimiter, verificarToken, async (req, res) => {
    try { res.json(await memoryMotor.obtenerPerfilCliente(req.params.phone)); } catch (e) { res.status(500).json({ error: e.message }); }
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
        // Auditoría
        await registrarAuditoria("confirmar_operacion", req,
            { operacion_id: req.params.id, monto: operacion.monto, phone: operacion.phone },
            operacion.phone
        );
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

// ── Plantillas de mensajes ──────────────────
app.get("/admin/plantillas", adminLimiter, verificarToken, async (req, res) => {
    try {
        const r = await pool.query("SELECT * FROM plantillas ORDER BY clave, idioma");
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/plantillas/:id", adminLimiter, verificarToken, async (req, res) => {
    try {
        const { texto } = req.body;
        if (!texto || !texto.trim()) return res.status(400).json({ error: "Texto requerido" });
        await pool.query(
            "UPDATE plantillas SET texto = $1, updated_at = NOW() WHERE id = $2",
            [texto.trim(), req.params.id]
        );
        // Invalidar cache de CRM para que tome los cambios inmediatamente
        crm.invalidarCachePlantillas();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════
// 1. CENTRO DE CONVERSACIONES
// Estado en tiempo real de cada cliente
// ══════════════════════════════════════

app.get("/admin/conversaciones", adminLimiter, verificarToken, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT
                c.phone, c.nombre, c.estado, c.estado_crm,
                c.ultimo_monto, c.tipo_favorito,
                c.ultima_interaccion, c.pausa_hasta,
                c.score_confianza, c.idioma,
                c.notas_internas,
                c.tarjeta_frecuente, c.banco_detectado,
                -- Última operación
                (SELECT status FROM operations WHERE phone = c.phone ORDER BY created_at DESC LIMIT 1) AS ultima_op_status,
                (SELECT created_at FROM operations WHERE phone = c.phone ORDER BY created_at DESC LIMIT 1) AS ultima_op_fecha
            FROM customers c
            WHERE c.ultima_interaccion > NOW() - INTERVAL '7 days'
            ORDER BY c.ultima_interaccion DESC
            LIMIT 100
        `);
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════
// 2. NOTAS INTERNAS POR CLIENTE
// ══════════════════════════════════════

app.get("/admin/notas/:phone", adminLimiter, verificarToken, async (req, res) => {
    try {
        const r = await pool.query("SELECT notas_internas FROM customers WHERE phone = $1", [req.params.phone]);
        res.json({ notas: r.rows[0]?.notas_internas || "" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/notas/:phone", adminLimiter, verificarToken, async (req, res) => {
    try {
        const { notas } = req.body;
        await pool.query(
            "UPDATE customers SET notas_internas = $1, updated_at = NOW() WHERE phone = $2",
            [notas || "", req.params.phone]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════
// 14. MODO OPERADOR — pausar/reanudar bot
// Pausa inmediata sin tiempo fijo (manual)
// ══════════════════════════════════════

app.post("/admin/pausar/:phone", adminLimiter, verificarToken, async (req, res) => {
    try {
        const { minutos = 60 } = req.body;
        await pool.query(`
            UPDATE customers
            SET pausa_hasta = NOW() + ($1 * INTERVAL '1 minute'), updated_at = NOW()
            WHERE phone = $2
        `, [minutos, req.params.phone]);
        await registrarAuditoria("pausar_bot", req, { minutos }, req.params.phone);
        res.json({ success: true, hasta: new Date(Date.now() + minutos * 60000) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/reanudar/:phone", adminLimiter, verificarToken, async (req, res) => {
    try {
        await pool.query(
            "UPDATE customers SET pausa_hasta = NULL, updated_at = NOW() WHERE phone = $1",
            [req.params.phone]
        );
        await registrarAuditoria("reanudar_bot", req, null, req.params.phone);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Estado de pausa de un cliente
app.get("/admin/pausa/:phone", adminLimiter, verificarToken, async (req, res) => {
    try {
        const r = await pool.query("SELECT pausa_hasta FROM customers WHERE phone = $1", [req.params.phone]);
        const hasta = r.rows[0]?.pausa_hasta;
        const activa = hasta && new Date(hasta) > new Date();
        res.json({ activa: !!activa, hasta: hasta || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════
// 11. PROMOCIONES PROGRAMADAS
// ══════════════════════════════════════

app.get("/admin/promociones", adminLimiter, verificarToken, async (req, res) => {
    try {
        // Crear tabla si no existe
        await pool.query(`
            CREATE TABLE IF NOT EXISTS promociones (
                id SERIAL PRIMARY KEY, titulo VARCHAR(100) NOT NULL,
                mensaje TEXT NOT NULL, activa BOOLEAN DEFAULT false,
                inicio_at TIMESTAMPTZ, fin_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        const r = await pool.query("SELECT * FROM promociones ORDER BY created_at DESC");
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/promociones", adminLimiter, verificarToken, async (req, res) => {
    try {
        const { titulo, mensaje, activa, inicio_at, fin_at } = req.body;
        await pool.query(`
            INSERT INTO promociones (titulo, mensaje, activa, inicio_at, fin_at)
            VALUES ($1, $2, $3, $4, $5)
        `, [titulo, mensaje, !!activa, inicio_at || null, fin_at || null]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/admin/promociones/:id", adminLimiter, verificarToken, async (req, res) => {
    try {
        const { titulo, mensaje, activa, inicio_at, fin_at } = req.body;
        await pool.query(`
            UPDATE promociones SET titulo=$1, mensaje=$2, activa=$3,
            inicio_at=$4, fin_at=$5, updated_at=NOW() WHERE id=$6
        `, [titulo, mensaje, !!activa, inicio_at || null, fin_at || null, req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/admin/promociones/:id", adminLimiter, verificarToken, async (req, res) => {
    try {
        await pool.query("DELETE FROM promociones WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Promo activa ahora (para que el bot la consulte)
app.get("/admin/promo-activa", adminLimiter, verificarToken, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT * FROM promociones
            WHERE activa = true
              AND (inicio_at IS NULL OR inicio_at <= NOW())
              AND (fin_at IS NULL OR fin_at >= NOW())
            ORDER BY created_at DESC LIMIT 1
        `);
        res.json(r.rows[0] || null);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════
// 17. AUDITORÍA
// ══════════════════════════════════════

app.get("/admin/auditoria", adminLimiter, verificarToken, async (req, res) => {
    try {
        const limite = Math.min(Number(req.query.limit) || 50, 200);
        const r = await pool.query(`
            SELECT * FROM audit_logs
            ORDER BY created_at DESC
            LIMIT $1
        `, [limite]);
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════
// 8. HISTORIAL DE COMPROBANTES
// ══════════════════════════════════════

app.get("/admin/comprobantes", adminLimiter, verificarToken, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT c.*, cu.nombre
            FROM comprobantes c
            LEFT JOIN customers cu ON cu.phone = c.phone
            ORDER BY c.created_at DESC
            LIMIT 100
        `);
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/comprobantes/:phone", adminLimiter, verificarToken, async (req, res) => {
    try {
        const r = await pool.query(
            "SELECT * FROM comprobantes WHERE phone = $1 ORDER BY created_at DESC LIMIT 20",
            [req.params.phone]
        );
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
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

// Crear tabla plantillas si no existe (safe)
(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS plantillas (
                id          VARCHAR(40)  PRIMARY KEY,
                clave       VARCHAR(40)  NOT NULL,
                idioma      VARCHAR(2)   NOT NULL,
                texto       TEXT         NOT NULL,
                descripcion VARCHAR(200),
                updated_at  TIMESTAMPTZ  DEFAULT NOW()
            )
        `);
        // Insertar plantillas default solo si la tabla está vacía
        const count = await pool.query("SELECT COUNT(*) FROM plantillas");
        if (Number(count.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO plantillas (id, clave, idioma, texto, descripcion) VALUES
                ('recuperar_30m_es','recuperar_30m','es','Hola{nombre} 😊 ¿Pudiste hacer el pago de R${monto}?

Estoy aquí si necesitas ayuda. 👌','Recordatorio 30 min (español)'),
                ('recuperar_30m_pt','recuperar_30m','pt','Oi{nombre} 😊 Conseguiu fazer o pagamento de R${monto}?

Estou aqui se precisar de ajuda. 👌','Recordatorio 30 min (portugués)'),
                ('recuperar_24h_es','recuperar_24h','es','Hola{nombre} 👋 Las tasas pueden haber cambiado.

¿Quieres una nueva cotización? Solo dime el monto 😊','Recordatorio 24h (español)'),
                ('recuperar_24h_pt','recuperar_24h','pt','Oi{nombre} 👋 As taxas podem ter mudado.

Quer uma nova cotação? É só me dizer o valor 😊','Recordatorio 24h (portugués)'),
                ('recuperar_7d_es','recuperar_7d','es','Hola{nombre} 🇨🇺 Estamos disponibles cuando necesites enviar a Cuba.

¿Alguna novedad? 😊','Reactivación 7 días (español)'),
                ('recuperar_7d_pt','recuperar_7d','pt','Oi{nombre} 🇨🇺 Estamos disponíveis quando precisar enviar para Cuba.

Alguma novidade? 😊','Reactivación 7 días (portugués)'),
                ('completado_frecuente_es','completado_frecuente','es','¡Gracias{nombre}! 🎉 Eres un cliente frecuente — aquí siempre tienes prioridad 💪','Cliente frecuente al completar (español)'),
                ('completado_frecuente_pt','completado_frecuente','pt','Obrigada{nombre}! 🎉 Você é um cliente frequente — aqui sempre tem prioridade 💪','Cliente frecuente al completar (portugués)')
                ON CONFLICT (id) DO NOTHING
            `);
            console.log("✅ Plantillas default insertadas");
        }
        console.log("✅ Tabla plantillas lista");
    } catch (e) {
        console.warn("⚠️ Plantillas init:", e.message);
    }
})();

// Ejecutar cada 15 minutos
setInterval(() => {
    crm.ejecutarRecordatorios().catch(e =>
        console.error("❌ CRM recordatorios:", e.message)
    );
}, 15 * 60 * 1000);

// ══════════════════════════════════════
// NUEVO ENDPOINT CRM STATS
// ══════════════════════════════════════

// (ya registrado arriba junto a /admin/stats)
