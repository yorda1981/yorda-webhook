const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const pool = require("./db");

const openaiService = require("./src/services/openai");
const { obtenerTodos, obtenerCliente } = require("./src/services/customer-memory");
const { obtenerTodas, confirmarOperacion, completarOperacion, obtenerEstadisticas } = require("./src/services/operations");
const crm = require("./src/services/crm");
const { leerTasas } = require("./src/flows/cotizacion-flow");
const { esPedidoWeb, procesarPedidoWeb } = require("./src/flows/pedido-web-flow");
const { enviarSeguro, getAdminPhone, getPIXKey, getPIXHolder, getPIXBank, getPIXImage } = require("./src/flows/shared");

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

// Límite estricto de intentos de login fallidos al dashboard (independiente del límite general).
// Solo cuenta peticiones que terminan en 401 (token incorrecto) — un token correcto nunca cuenta.
const authAttemptLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo." }
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
    try {
        await pool.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS saludo_pendiente BOOLEAN DEFAULT false");
    } catch (e) { console.error("⚠️ Migración saludo_pendiente:", e.message); }
    try {
        // Tarifa de entrega en efectivo (R$), configuración única — la usa la calculadora web.
        await pool.query("ALTER TABLE rates ADD COLUMN IF NOT EXISTS tarifa_entrega NUMERIC DEFAULT 0");
    } catch (e) { console.error("⚠️ Migración tarifa_entrega:", e.message); }
    try {
        // Datos de pedidos de entrega generados desde la calculadora web.
        await pool.query(`
            ALTER TABLE operations
                ADD COLUMN IF NOT EXISTS ref_web VARCHAR(20),
                ADD COLUMN IF NOT EXISTS direccion TEXT,
                ADD COLUMN IF NOT EXISTS provincia VARCHAR(60),
                ADD COLUMN IF NOT EXISTS municipio VARCHAR(60),
                ADD COLUMN IF NOT EXISTS referencia_entrega TEXT,
                ADD COLUMN IF NOT EXISTS telefono_entrega VARCHAR(30),
                ADD COLUMN IF NOT EXISTS entrega_disponible BOOLEAN,
                ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP
        `);
    } catch (e) { console.error("⚠️ Migración pedidos web:", e.message); }
    try {
        // Programa VIP por niveles (⭐/⭐⭐/⭐⭐⭐), recalculado sobre ventana móvil de 365 días.
        // nivel_vip: 0 = no VIP, 1/2/3 = nivel actual (puede subir o bajar con el tiempo).
        await pool.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS nivel_vip INTEGER DEFAULT 0");
        await pool.query(`
            ALTER TABLE rates
                ADD COLUMN IF NOT EXISTS umbral_vip_1 NUMERIC DEFAULT 10000,
                ADD COLUMN IF NOT EXISTS umbral_vip_2 NUMERIC DEFAULT 25000,
                ADD COLUMN IF NOT EXISTS umbral_vip_3 NUMERIC DEFAULT 50000,
                ADD COLUMN IF NOT EXISTS bono_vip_1 NUMERIC DEFAULT 1,
                ADD COLUMN IF NOT EXISTS bono_vip_2 NUMERIC DEFAULT 2,
                ADD COLUMN IF NOT EXISTS bono_vip_3 NUMERIC DEFAULT 3,
                ADD COLUMN IF NOT EXISTS descuento_entrega_1 NUMERIC DEFAULT 50,
                ADD COLUMN IF NOT EXISTS descuento_entrega_2 NUMERIC DEFAULT 75,
                ADD COLUMN IF NOT EXISTS descuento_entrega_3 NUMERIC DEFAULT 100
        `);
        await pool.query(`
            ALTER TABLE ofertas
                ADD COLUMN IF NOT EXISTS texto_vip TEXT,
                ADD COLUMN IF NOT EXISTS activa_vip BOOLEAN DEFAULT false
        `);
    } catch (e) { console.error("⚠️ Migración VIP por niveles:", e.message); }
    try {
        // Para no repetir la explicación completa de entrega si el cliente pregunta
        // varias veces seguidas en poco tiempo.
        await pool.query("ALTER TABLE customers ADD COLUMN IF NOT EXISTS ultimo_aviso_entrega TIMESTAMP");
    } catch (e) { console.error("⚠️ Migración ultimo_aviso_entrega:", e.message); }
})();

// ─────────────────────────────────────────
// PAUSA HUMANA — persistida en PostgreSQL
// Sobrevive reinicios de Railway.
// Se activa cuando el operador escribe desde
// el WhatsApp directamente (fromMe + !fromApi).
//
// Optimización (28/07/2026): antes esto hacía 2-3
// queries por CADA mensaje manual (UPDATE + SELECT +
// INSERT). Cuando el operador manda varios mensajes
// seguidos al mismo cliente, o hace rondas de disparos
// a varios clientes, esto multiplicaba las queries y
// disparó el consumo de cómputo en Neon.
// Ahora: 1) una sola query UPSERT, y 2) una caché en
// memoria que evita volver a tocar la DB si ya se
// extendió la pausa de ese número hace menos de 60s.
// ─────────────────────────────────────────

const ULTIMA_PAUSA_CACHE = new Map(); // phone -> timestamp (ms) de la última escritura real en DB
const DEBOUNCE_PAUSA_MS = 60 * 1000;  // no reescribir la misma pausa antes de 60s

async function activarPausaHumana(phone) {
    if (!phone) return;
    if (!String(phone).startsWith("55")) return;

    const ahora = Date.now();
    const ultima = ULTIMA_PAUSA_CACHE.get(phone);
    if (ultima && (ahora - ultima) < DEBOUNCE_PAUSA_MS) {
        // Ya se extendió la pausa hace poco (ráfaga de mensajes del operador
        // al mismo cliente) — el cliente sigue silenciado igual, no hace
        // falta volver a escribir en PostgreSQL.
        return;
    }

    try {
        await pool.query(`
            INSERT INTO customers (phone, pausa_hasta, created_at, updated_at)
            VALUES ($1, NOW() + ($2 * INTERVAL '1 minute'), NOW(), NOW())
            ON CONFLICT (phone) DO UPDATE
            SET pausa_hasta = NOW() + ($2 * INTERVAL '1 minute'),
                updated_at  = NOW()
        `, [phone, MINUTOS_PAUSA]);
        ULTIMA_PAUSA_CACHE.set(phone, ahora);
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
app.use("/admin", authAttemptLimiter);

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

        // Pedido generado por la calculadora web (entrega o transferencia) — se procesa aparte, sin pasar por GPT.
        if (esPedidoWeb(textMessage)) {
            try {
                const manejado = await procesarPedidoWeb(phoneRaw, textMessage, pushName);
                if (manejado) return;
            } catch (e) {
                console.error("❌ Error procesando pedido web:", e.message);
            }
            // si no se pudo interpretar (mensaje editado/incompleto), sigue el flujo normal abajo
        }

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
        const {
            brl_0, brl_100, brl_500, brl_1000, usd1, usd2, mlc, efectivo, tarifa_entrega,
            umbral_vip_1, umbral_vip_2, umbral_vip_3,
            bono_vip_1, bono_vip_2, bono_vip_3,
            descuento_entrega_1, descuento_entrega_2, descuento_entrega_3
        } = req.body;
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
                tarifa_entrega = COALESCE($9, tarifa_entrega),
                umbral_vip_1 = COALESCE($10, umbral_vip_1),
                umbral_vip_2 = COALESCE($11, umbral_vip_2),
                umbral_vip_3 = COALESCE($12, umbral_vip_3),
                bono_vip_1   = COALESCE($13, bono_vip_1),
                bono_vip_2   = COALESCE($14, bono_vip_2),
                bono_vip_3   = COALESCE($15, bono_vip_3),
                descuento_entrega_1 = COALESCE($16, descuento_entrega_1),
                descuento_entrega_2 = COALESCE($17, descuento_entrega_2),
                descuento_entrega_3 = COALESCE($18, descuento_entrega_3),
                updated_at = NOW()
            WHERE id = 1
        `, [
            brl_0, brl_100, brl_500, brl_1000, usd1, usd2, mlc, efectivo, tarifa_entrega,
            umbral_vip_1, umbral_vip_2, umbral_vip_3,
            bono_vip_1, bono_vip_2, bono_vip_3,
            descuento_entrega_1, descuento_entrega_2, descuento_entrega_3
        ]);
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
    try {
        const dias = req.query.dias ? Number(req.query.dias) : 30;
        res.json(await crm.obtenerEstadisticasCRM(dias));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/completar-todas-antiguas", adminLimiter, verificarToken, async (req, res) => {
    try {
        const r = await pool.query(`
            UPDATE operations SET status = 'completada', completed_at = NOW()
            WHERE status = 'confirmada'
            RETURNING id
        `);
        res.json({ success: true, actualizadas: r.rows.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/admin/confirmar-operacion/:id", adminLimiter, verificarToken, async (req, res) => {
    try {
        const operacion = await confirmarOperacion(req.params.id);
        if (!operacion) return res.status(404).json({ success: false, error: "Operación no encontrada" });

        const { enviarMensaje } = require("./src/services/zapi");
        const esEntrega = operacion.tipo === "cup_efectivo" || operacion.tipo === "usd_efectivo";
        const cuerpo = esEntrega
            ? "Procederemos a coordinar su entrega en Cuba."
            : "Procederemos a realizar la transferencia a Cuba.";
        const notaPlazo = esEntrega
            ? "\n\n🚚 Recuerda: la entrega puede demorar hasta 48 horas, según la demanda y disponibilidad."
            : "";
        const notificado = await enviarMensaje(
            operacion.phone,
            `✅ Recibimos su pago de R$${operacion.monto}.\n\n${cuerpo}\n\nCuando se complete le enviaremos el comprobante. 😊${notaPlazo}`
        );
        if (!notificado) console.error(`⚠️ No se pudo notificar al cliente de la operación #${operacion.id} (phone: ${operacion.phone})`);

        res.json({ success: true, notificado });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/admin/completar-operacion/:id", adminLimiter, verificarToken, async (req, res) => {
    try {
        const operacion = await completarOperacion(req.params.id);
        if (!operacion) return res.status(404).json({ success: false, error: "Operación no encontrada" });

        const { enviarMensaje } = require("./src/services/zapi");
        const esEntrega = operacion.tipo === "cup_efectivo" || operacion.tipo === "usd_efectivo";
        const msg = esEntrega
            ? "🎉 ¡Tu entrega fue completada con éxito! Gracias por preferir nuestros servicios. 🇨🇺💜"
            : "🎉 ¡Tu transferencia fue completada con éxito! Gracias por preferir nuestros servicios. 🇨🇺💜";
        const notificado = await enviarMensaje(operacion.phone, msg);
        if (!notificado) console.error(`⚠️ No se pudo notificar al cliente de la operación #${operacion.id} (phone: ${operacion.phone})`);

        // Si este pedido venía de la calculadora, el cliente estaba en "modo
        // silencio" con el bot (ver openai.js). Ya se completó todo — se le
        // quita esa marca para que pueda volver a hablar normal con el bot
        // si hace un pedido nuevo en el futuro.
        try {
            await pool.query(
                "UPDATE customers SET estado = NULL WHERE phone = $1 AND estado = 'pedido_web_pendiente'",
                [operacion.phone]
            );
        } catch (e) {
            console.error("⚠️ Error limpiando estado pedido_web_pendiente:", e.message);
        }

        // Programa VIP: recalcula el nivel (0-3) sobre los últimos 365 días. Si subió,
        // se le avisa con el nivel nuevo. Si bajó, se actualiza en silencio (no se
        // manda un mensaje negativo al cliente).
        try {
            const { nivelAnterior, nivelNuevo } = await crm.recalcularNivelVipUno(operacion.phone);
            if (nivelNuevo > nivelAnterior) {
                const estrellas = "⭐".repeat(nivelNuevo);
                const mVip = `🌟 *¡Felicidades! Ahora eres cliente VIP ${estrellas} de Yorda Envíos!*\n\nDesde ahora tienes:\n💰 Tasa preferencial en tus próximas transferencias\n🚚 Descuento en tus pedidos de entrega en efectivo\n🎁 Promociones exclusivas para ti\n\n¡Gracias por confiar en nosotros! 💜🇨🇺`;
                await enviarMensaje(operacion.phone, mVip);
            } else if (nivelNuevo < nivelAnterior) {
                console.log(`ℹ️ Cliente ${operacion.phone} bajó de nivel VIP: ${nivelAnterior} → ${nivelNuevo}`);
            }
        } catch (e) {
            console.error("⚠️ Error recalculando nivel VIP:", e.message);
        }

        res.json({ success: true, notificado });
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
        const { texto, activa, vence_at, texto_vip, activa_vip } = req.body;
        await pool.query(`
            UPDATE ofertas SET
                texto = $1,
                activa = $2,
                vence_at = $3,
                texto_vip = $4,
                activa_vip = $5,
                updated_at = NOW()
            WHERE id = 1
        `, [texto, activa, vence_at || null, texto_vip || null, !!activa_vip]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/tasas", async (req, res) => {
    try {
        const r = await pool.query("SELECT brl_0, brl_100, brl_500, brl_1000, usd1, mlc, efectivo, tarifa_entrega FROM rates LIMIT 1");
        let oferta = null;
        try {
            const o = await pool.query("SELECT texto FROM ofertas WHERE activa = true AND (vence_at IS NULL OR vence_at > NOW()) LIMIT 1");
            oferta = o.rows[0]?.texto || null;
        } catch {}
        res.json({ ...(r.rows[0] || {}), oferta });
    } catch (e) { res.status(500).json({}); }
});

// Datos públicos de PIX (no son secretos: son los datos que el cliente necesita para pagarnos).
// Reutiliza la configuración ya existente del bot (PIX_KEY / PIX_HOLDER_NAME / PIX_BANK / PIX_IMAGE_URL).
app.get("/api/pix-info", (req, res) => {
    res.json({
        key:   getPIXKey(),
        holder: getPIXHolder(),
        bank:  getPIXBank(),
        image: getPIXImage()
    });
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

// Recalcular niveles VIP (⭐/⭐⭐/⭐⭐⭐) de TODOS los clientes una vez al día.
// Ventana móvil de 365 días — esto es lo que detecta cuando alguien BAJA de
// nivel por inactividad (no solo cuando sube al completar una operación nueva).
// Solo avisa por WhatsApp a quien SUBIÓ; las bajadas se aplican en silencio.
async function recalcularNivelesVipYAvisar() {
    try {
        const cambios = await crm.recalcularNivelesVip();
        for (const c of cambios) {
            if (c.nivel_nuevo > c.nivel_anterior) {
                const estrellas = "⭐".repeat(c.nivel_nuevo);
                const mVip = `🌟 *¡Felicidades! Ahora eres cliente VIP ${estrellas} de Yorda Envíos!*\n\nDesde ahora tienes:\n💰 Tasa preferencial en tus próximas transferencias\n🚚 Descuento en tus pedidos de entrega en efectivo\n🎁 Promociones exclusivas para ti\n\n¡Gracias por confiar en nosotros! 💜🇨🇺`;
                await enviarMensaje(c.phone, mVip);
            } else {
                console.log(`ℹ️ Cliente ${c.phone} bajó de nivel VIP: ${c.nivel_anterior} → ${c.nivel_nuevo}`);
            }
        }
    } catch (e) {
        console.error("❌ CRM recalcular niveles VIP:", e.message);
    }
}
setTimeout(recalcularNivelesVipYAvisar, 10 * 1000); // espera un poco a que terminen las migraciones al arrancar
setInterval(recalcularNivelesVipYAvisar, 24 * 60 * 60 * 1000);

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
// SALUDO MATUTINO (8:00 hora de Bahía = 11:00 UTC)
// A quien escribió fuera de horario se le envía un saludo al abrir.
// ══════════════════════════════════════
const { obtenerSaludosPendientes, limpiarSaludoPendiente } = require("./src/services/customer-memory");
let ultimoSaludo = "";

async function enviarSaludosMatutinos() {
    const pendientes = await obtenerSaludosPendientes();
    if (!pendientes.length) return;
    for (const c of pendientes) {
        const nombre = c.nombre ? ` ${String(c.nombre).split(" ")[0]}` : "";
        const msg = `¡Buenos días${nombre}! 👋 Recibimos tu mensaje pero estábamos fuera de horario. Ya estamos activos y listos para atenderte 😊 ¿En qué te podemos ayudar?`;
        await enviarSeguro(c.phone, msg);
        await limpiarSaludoPendiente(c.phone);
    }
    console.log(`✅ Saludos matutinos enviados: ${pendientes.length}`);
}

// Revisa cada minuto; dispara una sola vez a las 11:00 UTC (8:00 Bahía)
setInterval(() => {
    const ahora = new Date();
    const hoyKey = ahora.toISOString().slice(0, 10);
    if (ahora.getUTCHours() === 11 && ahora.getUTCMinutes() === 0 && ultimoSaludo !== hoyKey) {
        ultimoSaludo = hoyKey;
        enviarSaludosMatutinos().catch(e => console.error("❌ Saludos matutinos:", e.message));
    }
}, 60 * 1000);

// ══════════════════════════════════════
// NUEVO ENDPOINT CRM STATS
// ══════════════════════════════════════

// (ya registrado arriba junto a /admin/stats)
