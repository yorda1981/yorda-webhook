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
const entregasService = require("./src/services/entregas");
const { leerTasas } = require("./src/flows/cotizacion-flow");
const { esPedidoWeb, procesarPedidoWeb, crearEntregaManual } = require("./src/flows/pedido-web-flow");
const { enviarSeguro, getAdminPhone, getPIXKey, getPIXHolder, getPIXBank, getPIXImage } = require("./src/flows/shared");
const { yaFueProcesado, activarPausaHumana, enPausaHumana, limpiarWebhookEventsViejos } = require("./src/services/webhook-guard");
const { verificarSecretoWebhook, validarPayloadWebhook } = require("./src/middleware/webhook-security");
const { conLockExclusivo } = require("./src/services/job-lock");
const { log } = require("./src/utils/structured-logger");
const { adminReadLimiter, adminWriteLimiter } = require("./src/middleware/admin-rate-limiters");
const { verificarToken, verificarTokenEntregas } = require("./src/middleware/admin-auth");
const blockedNumbers = require("./src/services/blocked-numbers");

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

// adminReadLimiter/adminWriteLimiter (src/middleware/admin-rate-limiters.js)
// y la protección de intentos de login (src/middleware/admin-auth.js +
// auth-attempt-limiter.js) reemplazan al viejo adminLimiter único y al
// authAttemptLimiter global — ver esos archivos para el porqué.

const buffers            = new Map();
const pendingMessages    = new Map();
const mapaLidATelefono   = new Map();

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
    try {
        // ─────────────────────────────────────────
        // CRM DE ENTREGAS — separado por completo de "operations".
        // Solo entregas de EFECTIVO (CUP/USD) viven aquí. Las
        // transferencias siguen su flujo normal en "operations" y
        // nunca tocan estas tablas.
        // ─────────────────────────────────────────
        await pool.query("CREATE SEQUENCE IF NOT EXISTS entregas_codigo_seq START WITH 1000");
        await pool.query("CREATE SEQUENCE IF NOT EXISTS entregas_pago_codigo_seq START WITH 1");

        await pool.query(`
            CREATE TABLE IF NOT EXISTS entregas_pagos (
                id               SERIAL PRIMARY KEY,
                codigo           VARCHAR(20) UNIQUE NOT NULL,
                cantidad_enviada NUMERIC,
                moneda_pago      VARCHAR(20),
                fecha            DATE,
                txid             VARCHAR(150),
                observacion      TEXT,
                created_at       TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS entregas (
                id                SERIAL PRIMARY KEY,
                codigo            VARCHAR(20) UNIQUE NOT NULL,
                operation_id      INTEGER REFERENCES operations(id),
                ref_web           VARCHAR(20),
                phone             VARCHAR(30) NOT NULL,
                cliente_nombre    VARCHAR(150),
                telefono_entrega  VARCHAR(30),
                cantidad          NUMERIC NOT NULL,
                moneda            VARCHAR(3) NOT NULL,
                modalidad         VARCHAR(20) NOT NULL DEFAULT 'EFECTIVO',
                provincia         VARCHAR(60),
                municipio         VARCHAR(60),
                direccion         TEXT,
                referencia        TEXT,
                observaciones     TEXT,
                estado_entrega    VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
                fecha_entrega     TIMESTAMP,
                entregado_por     VARCHAR(100),
                estado_pago       VARCHAR(20) NOT NULL DEFAULT 'NO_APLICA',
                pago_id           INTEGER REFERENCES entregas_pagos(id),
                created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `);
        await pool.query("CREATE INDEX IF NOT EXISTS idx_entregas_estado_entrega ON entregas(estado_entrega)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_entregas_estado_pago ON entregas(estado_pago)");
        await pool.query("CREATE INDEX IF NOT EXISTS idx_entregas_phone ON entregas(phone)");

        await pool.query(`
            CREATE TABLE IF NOT EXISTS entregas_historial (
                id          SERIAL PRIMARY KEY,
                entrega_id  INTEGER NOT NULL REFERENCES entregas(id),
                evento      TEXT NOT NULL,
                created_at  TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `);
        // Para no repetir el aviso de "entrega atrasada" cada vez que corre el job.
        await pool.query("ALTER TABLE entregas ADD COLUMN IF NOT EXISTS ultimo_aviso_atraso TIMESTAMP");

        // Tasa CUP/USD → USDT — la edita Yordanys o su compañera desde el propio
        // CRM de Entregas, solo para sugerir el monto en USDT al registrar un
        // pago (nunca se aplica sola — ver obtenerTasasUsdt en entregas.js).
        await pool.query(`
            CREATE TABLE IF NOT EXISTS entregas_tasas (
                id            INTEGER PRIMARY KEY DEFAULT 1,
                tasa_usdt_cup NUMERIC NOT NULL DEFAULT 0,
                tasa_usdt_usd NUMERIC NOT NULL DEFAULT 0,
                updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `);
        await pool.query("INSERT INTO entregas_tasas (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
    } catch (e) { console.error("⚠️ Migración CRM de Entregas:", e.message); }
})();

// Pausa humana (fromMe manual) y deduplicación de messageId ahora viven en
// src/services/webhook-guard.js (mismo comportamiento, movido para poder
// testearlo — ver test/webhook-guard.test.js).

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));
// verificarToken/verificarTokenEntregas ahora viven en
// src/middleware/admin-auth.js — ya incluyen su propia protección contra
// intentos de token inválido (src/middleware/auth-attempt-limiter.js),
// aplicada por-ruta en vez de globalmente con app.use("/admin", ...).

// ==========================================
// WEBHOOK
// ==========================================

app.post("/webhook", verificarSecretoWebhook, webhookLimiter, validarPayloadWebhook, async (req, res) => {
    res.status(200).send("OK");
    try {
        const body = req.body;
        if (!body) return;

        const phoneRaw = body.phone || body.from;
        log("WEBHOOK_RECEIVED", { type: body.type, phone: phoneRaw, fromMe: !!body.fromMe });

        if (body.chatLid && body.phone && body.phone.startsWith("55") && !body.fromMe) {
            mapaLidATelefono.set(body.chatLid, body.phone);
        }

        if (body.isGroup || String(phoneRaw).includes("-group")) return;
        if (body.isNewsletter) return;

        if (body.fromMe) {
            if (body.fromApi !== true) {
                const telefonoCliente = mapaLidATelefono.get(body.chatLid);

                // Muchos clientes no saben llenar la calculadora, así que el
                // operador la llena él mismo y manda el pedido desde su propio
                // WhatsApp, dentro del chat del cliente. Antes esto solo activaba
                // la pausa humana y el pedido se perdía (nunca se creaba la
                // entrega ni llegaba el aviso). Ahora, si el texto es un pedido
                // web válido, se procesa igual que si lo mandara el cliente.
                const textoFromMe = body.text?.message || body.body || body.caption || "";
                if (telefonoCliente && esPedidoWeb(textoFromMe)) {
                    try {
                        await procesarPedidoWeb(telefonoCliente, textoFromMe, "Cliente");
                    } catch (e) {
                        console.error("❌ Error procesando pedido web (enviado por el operador):", e.message);
                    }
                    return;
                }

                if (telefonoCliente) await activarPausaHumana(telefonoCliente);
            }
            return;
        }

        if (!phoneRaw || phoneRaw.includes("@lid")) return;
        if (!phoneRaw.startsWith("55")) return;

        const tiposValidos = ["ReceivedCallback", "image", "document", "audio", "video"];
        if (!tiposValidos.includes(body.type)) return;

        const messageId = body.messageId || body.id || body.zeId;
        if (await yaFueProcesado(messageId)) return;

        // Número bloqueado: cero automatización, ni siquiera llega al portón
        // de gatillos ni a la pausa humana. No borra ni toca nada de
        // customers/operations/entregas — ver src/services/blocked-numbers.js.
        if (await blockedNumbers.estaBloqueado(phoneRaw)) {
            console.log(`🚫 Número bloqueado, sin respuesta: ${phoneRaw}`);
            return;
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
                log("MESSAGE_PROCESSED", { phone: phoneRaw });
            } catch (e) {
                console.error(`❌ Error OpenAI: ${e.message}`);
                log("EXTERNAL_API_ERROR", { origen: "openai.procesarMensaje", error: e.message });
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

app.get("/admin/tasas", adminReadLimiter, verificarToken, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM rates LIMIT 1");
        res.json(result.rows[0] || {});
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/tasas", adminWriteLimiter, verificarToken, async (req, res) => {
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

app.get("/admin/clientes", adminReadLimiter, verificarToken, async (req, res) => {
    try { res.json(await obtenerTodos()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/operaciones", adminReadLimiter, verificarToken, async (req, res) => {
    try { res.json(await obtenerTodas()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/stats", adminReadLimiter, verificarToken, async (req, res) => {
    try { res.json(await obtenerEstadisticas()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/crm/stats", adminReadLimiter, verificarToken, async (req, res) => {
    try {
        const dias = req.query.dias ? Number(req.query.dias) : 30;
        res.json(await crm.obtenerEstadisticasCRM(dias));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/bloqueados", adminReadLimiter, verificarToken, async (req, res) => {
    try { res.json(await blockedNumbers.listarBloqueados()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/bloqueados", adminWriteLimiter, verificarToken, async (req, res) => {
    try {
        const { telefono, motivo } = req.body || {};
        if (!telefono) return res.status(400).json({ error: "Falta el teléfono" });
        const r = await blockedNumbers.bloquear(telefono, motivo);
        if (r.error) return res.status(500).json({ error: r.error });
        res.json({ success: true, ...r });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/bloqueados/:telefono/desbloquear", adminWriteLimiter, verificarToken, async (req, res) => {
    try {
        const ok = await blockedNumbers.desbloquear(req.params.telefono);
        res.json({ success: ok });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/completar-todas-antiguas", adminWriteLimiter, verificarToken, async (req, res) => {
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

app.post("/admin/confirmar-operacion/:id", adminWriteLimiter, verificarToken, async (req, res) => {
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

app.post("/admin/completar-operacion/:id", adminWriteLimiter, verificarToken, async (req, res) => {
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
            if (nivelNuevo > nivelAnterior && !(await blockedNumbers.estaBloqueado(operacion.phone))) {
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

// ─────────────────────────────────────────
// CRM DE ENTREGAS — completamente separado de "operations".
// Solo entregas de EFECTIVO (CUP/USD) viven aquí.
// ─────────────────────────────────────────

app.get("/admin/entregas", adminReadLimiter, verificarTokenEntregas, async (req, res) => {
    try {
        const filtros = {
            q:             req.query.q,
            codigo:        req.query.codigo,
            cliente:       req.query.cliente,
            telefono:      req.query.telefono,
            fechaDesde:    req.query.fechaDesde,
            fechaHasta:    req.query.fechaHasta,
            provincia:     req.query.provincia,
            moneda:        req.query.moneda,
            estadoEntrega: req.query.estadoEntrega,
            estadoPago:    req.query.estadoPago
        };
        res.json(await entregasService.obtenerEntregas(filtros));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/entregas/stats", adminReadLimiter, verificarTokenEntregas, async (req, res) => {
    try { res.json(await entregasService.obtenerEstadisticasEntregas()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/entregas/:id/entregado", adminWriteLimiter, verificarTokenEntregas, async (req, res) => {
    try {
        const entrega = await entregasService.marcarEntregado(req.params.id, req.body.usuario || "Panel admin");
        if (!entrega) return res.status(404).json({ success: false, error: "Entrega no encontrada o ya no está PENDIENTE" });

        // Aviso a tu número — así te enteras aunque el cambio lo haga tu
        // compañera desde el acceso reducido (/entregas).
        try {
            await enviarSeguro(getAdminPhone(),
                `✅ Entrega ${entrega.codigo} marcada como ENTREGADO.\n\n` +
                `Cliente: ${entrega.cliente_nombre}\n` +
                `${Number(entrega.cantidad).toLocaleString("es-ES")} ${entrega.moneda}\n\n` +
                `💵 Pago al contacto: PENDIENTE DE PAGO`
            );
        } catch (e) { console.error("⚠️ No se pudo notificar entrega marcada:", e.message); }

        res.json({ success: true, entrega });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/admin/entregas/:id/cancelar", adminWriteLimiter, verificarTokenEntregas, async (req, res) => {
    try {
        const entrega = await entregasService.marcarCancelado(req.params.id, req.body.motivo || "");
        if (!entrega) return res.status(404).json({ success: false, error: "Entrega no encontrada o ya no está PENDIENTE" });
        res.json({ success: true, entrega });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Pago al contacto en Cuba — individual o agrupado (varias entregas a la vez).
// Puramente histórico: NO calcula ni convierte monedas, solo guarda lo que
// se le pasa. Solo afecta entregas que realmente están PENDIENTE_DE_PAGO.
app.post("/admin/entregas/pago", adminWriteLimiter, verificarTokenEntregas, async (req, res) => {
    try {
        const { entregaIds, cantidadEnviada, monedaPago, fecha, txid, observacion } = req.body;
        if (!Array.isArray(entregaIds) || entregaIds.length === 0) {
            return res.status(400).json({ success: false, error: "Debes indicar al menos una entrega (entregaIds)" });
        }
        const resultado = await entregasService.registrarPago(entregaIds, { cantidadEnviada, monedaPago, fecha, txid, observacion });
        if (!resultado) return res.status(500).json({ success: false, error: "No se pudo registrar el pago" });

        // Aviso a tu número — mismo motivo que en "entregado": que te enteres
        // aunque el registro lo haga tu compañera.
        try {
            const codigos = resultado.entregas.map(e => e.codigo).join(", ") || "—";
            await enviarSeguro(getAdminPhone(),
                `💵 Pago ${resultado.pago.codigo} registrado.\n\n` +
                `Entregas incluidas: ${codigos}\n` +
                (resultado.pago.cantidad_enviada ? `Cantidad enviada: ${resultado.pago.cantidad_enviada} ${resultado.pago.moneda_pago || ""}\n` : "") +
                `Estado: PAGADO`
            );
        } catch (e) { console.error("⚠️ No se pudo notificar pago registrado:", e.message); }

        res.json({ success: true, ...resultado });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/admin/entregas/pago/:codigo", adminReadLimiter, verificarTokenEntregas, async (req, res) => {
    try {
        const pago = await entregasService.obtenerPago(req.params.codigo);
        if (!pago) return res.status(404).json({ error: "Pago no encontrado" });
        res.json(pago);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/entregas/:id/historial", adminReadLimiter, verificarTokenEntregas, async (req, res) => {
    try { res.json(await entregasService.obtenerHistorialDe(req.params.id)); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Tasa CUP/USD → USDT — la puede ver y editar cualquiera de los dos (admin o
// compañera) desde el propio CRM de Entregas. Solo sirve para sugerir el
// monto en USDT al registrar un pago; nunca se aplica sola.
app.get("/admin/entregas/tasa-usdt", adminReadLimiter, verificarTokenEntregas, async (req, res) => {
    try { res.json(await entregasService.obtenerTasasUsdt()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Creación manual de una entrega — para cuando el cliente no sabe llenar la
// calculadora y Yordanys ingresa los datos directamente. Solo ADMIN_TOKEN
// (incluye el monto en reales, que tu compañera no debe ver). No depende de
// ningún mensaje de WhatsApp, así que evita el problema de "mensaje a uno
// mismo" que no se podía identificar de forma confiable.
app.post("/admin/entregas/manual", adminWriteLimiter, verificarToken, async (req, res) => {
    try {
        const resultado = await crearEntregaManual(req.body || {});
        if (resultado.error) return res.status(400).json({ error: resultado.error });
        res.json(resultado);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/entregas/tasa-usdt", adminWriteLimiter, verificarTokenEntregas, async (req, res) => {
    try {
        const actualizado = await entregasService.actualizarTasasUsdt(req.body || {});
        if (!actualizado) return res.status(500).json({ error: "No se pudo actualizar" });
        res.json({ success: true, ...actualizado });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/dashboard", (req, res) =>
    res.sendFile(path.join(__dirname, "public", "dashboard.html"))
);

// Panel reducido, solo para el CRM de Entregas — pensado para compartir con
// alguien que no debe ver tasas, VIP ni ofertas. Usa ENTREGAS_TOKEN (o el
// ADMIN_TOKEN normal) contra los mismos endpoints /admin/entregas...
app.get("/entregas", (req, res) =>
    res.sendFile(path.join(__dirname, "public", "entregas.html"))
);

// Recargas
app.get("/admin/recargas", adminReadLimiter, verificarToken, async (req, res) => {
    try {
        const r = await pool.query("SELECT * FROM recargas ORDER BY tipo");
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/recargas/:tipo", adminWriteLimiter, verificarToken, async (req, res) => {
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
app.get("/admin/oferta", adminReadLimiter, verificarToken, async (req, res) => {
    try {
        const r = await pool.query("SELECT * FROM ofertas LIMIT 1");
        res.json(r.rows[0] || {});
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/oferta", adminWriteLimiter, verificarToken, async (req, res) => {
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

// Ejecutar cada 15 minutos. conLockExclusivo (Fase 6): si Railway llegara
// a tener dos instancias corriendo a la vez, solo una ejecuta esta ronda —
// evita recordatorios duplicados al mismo cliente.
setInterval(() => {
    conLockExclusivo("crmRecordatorios", () => crm.ejecutarRecordatorios())
        .catch(e => console.error("❌ CRM recordatorios:", e.message));
}, 15 * 60 * 1000);

// Recalcular niveles VIP (⭐/⭐⭐/⭐⭐⭐) de TODOS los clientes una vez al día.
// Ventana móvil de 365 días — esto es lo que detecta cuando alguien BAJA de
// nivel por inactividad (no solo cuando sube al completar una operación nueva).
// Solo avisa por WhatsApp a quien SUBIÓ; las bajadas se aplican en silencio.
async function recalcularNivelesVipYAvisar() {
    try {
        const cambios = await crm.recalcularNivelesVip();
        for (const c of await blockedNumbers.filtrarNoBloqueados(cambios)) {
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
function recalcularNivelesVipYAvisarConLock() {
    return conLockExclusivo("vipRecalculo", recalcularNivelesVipYAvisar);
}
setTimeout(recalcularNivelesVipYAvisarConLock, 10 * 1000); // espera un poco a que terminen las migraciones al arrancar
setInterval(recalcularNivelesVipYAvisarConLock, 24 * 60 * 60 * 1000);

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
        conLockExclusivo("tasasDiarias", enviarTasasDiarias)
            .catch(e => console.error("❌ Tasas diarias:", e.message));
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
        conLockExclusivo("saludosMatutinos", enviarSaludosMatutinos)
            .catch(e => console.error("❌ Saludos matutinos:", e.message));
    }
}, 60 * 1000);

// ══════════════════════════════════════
// CRM DE ENTREGAS — AVISO DE ENTREGAS ATRASADAS
// Si una entrega lleva más de 48h (2 días) en PENDIENTE, te avisa por
// WhatsApp. NUNCA cambia el estado — solo notifica (sección 10 del CRM).
// Si sigue pendiente al día siguiente, vuelve a avisar (no se repite antes
// de 24h para no saturar).
// ══════════════════════════════════════
const HORAS_UMBRAL_ATRASO = 48;

async function avisarEntregasAtrasadas() {
    try {
        const atrasadas = await entregasService.obtenerEntregasAtrasadasSinAvisar(HORAS_UMBRAL_ATRASO);
        if (!atrasadas.length) return;

        const lineas = atrasadas.map(e => {
            const dias = Math.floor((Date.now() - new Date(e.created_at).getTime()) / (1000 * 60 * 60 * 24));
            return `• ${e.codigo} — ${Number(e.cantidad).toLocaleString("es-ES")} ${e.moneda} — ${e.cliente_nombre} — pendiente hace ${dias} día(s)`;
        });

        await enviarSeguro(getAdminPhone(),
            `⚠️ *Entregas atrasadas* (más de ${HORAS_UMBRAL_ATRASO}h pendientes):\n\n${lineas.join("\n")}`
        );
        await entregasService.marcarAvisoAtrasoEnviado(atrasadas.map(e => e.id));
        console.log(`⚠️ Aviso de ${atrasadas.length} entrega(s) atrasada(s) enviado`);
    } catch (e) {
        console.error("❌ Error avisando entregas atrasadas:", e.message);
    }
}
function avisarEntregasAtrasadasConLock() {
    return conLockExclusivo("entregasAtrasadas", avisarEntregasAtrasadas);
}
setTimeout(avisarEntregasAtrasadasConLock, 30 * 1000); // espera a que terminen las migraciones al arrancar
setInterval(avisarEntregasAtrasadasConLock, 6 * 60 * 60 * 1000); // revisa cada 6 horas

// ══════════════════════════════════════
// LIMPIEZA DE webhook_events (Fase 6) — borra eventos de dedup de más de
// 1 día. Corre una vez al día, con el mismo mecanismo de lock.
// ══════════════════════════════════════
setTimeout(() => conLockExclusivo("limpiezaWebhookEvents", limpiarWebhookEventsViejos), 60 * 1000);
setInterval(() => conLockExclusivo("limpiezaWebhookEvents", limpiarWebhookEventsViejos), 24 * 60 * 60 * 1000);

// ══════════════════════════════════════
// NUEVO ENDPOINT CRM STATS
// ══════════════════════════════════════

// (ya registrado arriba junto a /admin/stats)
