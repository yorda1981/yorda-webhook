/**
 * crm.js — Motor CRM de Yorda
 *
 * Estados comerciales:
 *   nuevo_cliente        → primer contacto, aún no cotizó
 *   cotizado             → recibió una cotización
 *   esperando_pix        → recibió el PIX, no ha pagado
 *   esperando_comprobante→ dijo que pagó, falta el comprobante
 *   completado           → operación confirmada por el admin
 *   abandono             → sin respuesta tras varios intentos
 *   cliente_frecuente    → bandera adicional (columna aparte)
 *
 * Recordatorios automáticos (ejecutar cada 15 min):
 *   30 min post-cotización sin PIX     → recuperar_30m
 *   24 h  post-cotización sin cierre   → recuperar_24h
 *   7 d   sin actividad                → recuperar_7d
 */

"use strict";

const pool          = require("../../db");
const { enviarMensaje } = require("./zapi");

// ─────────────────────────────────────────
// DETECCIÓN DE IDIOMA
// ─────────────────────────────────────────

/**
 * Retorna "pt" si el cliente habla portugués, "es" si español.
 * Usa el campo idioma guardado en customers; si no existe, "es".
 */
function idioma(cliente) {
    return (cliente?.idioma || "es") === "pt" ? "pt" : "es";
}

/** Detecta el idioma del texto y devuelve "pt" o "es" */
function detectarIdioma(texto) {
    if (!texto) return "es";
    const t = texto.toLowerCase();
    const marcadoresPt = [
        "quero", "vou", "obrigado", "obrigada", "por favor",
        "quanto", "reais", "meu", "minha", "você", "pra",
        "preciso", "enviar", "cartão", "comprovante"
    ];
    const hits = marcadoresPt.filter(m => t.includes(m)).length;
    return hits >= 2 ? "pt" : "es";
}

// ─────────────────────────────────────────
// MENSAJES POR IDIOMA
// ─────────────────────────────────────────

const MSGS = {
    recuperar_30m: {
        es: (nombre, monto) =>
            `Hola${nombre ? ` ${nombre}` : ""} 😊 ¿Pudiste hacer el pago de R$${monto}?\n\nEstoy aquí si necesitas ayuda. 👌`,
        pt: (nombre, monto) =>
            `Oi${nombre ? ` ${nombre}` : ""} 😊 Conseguiu fazer o pagamento de R$${monto}?\n\nEstou aqui se precisar de ajuda. 👌`
    },
    recuperar_24h: {
        es: (nombre) =>
            `Hola${nombre ? ` ${nombre}` : ""} 👋 Las tasas pueden haber cambiado.\n\n¿Quieres una nueva cotización? Solo dime el monto 😊`,
        pt: (nombre) =>
            `Oi${nombre ? ` ${nombre}` : ""} 👋 As taxas podem ter mudado.\n\nQuer uma nova cotação? É só me dizer o valor 😊`
    },
    recuperar_7d: {
        es: (nombre) =>
            `Hola${nombre ? ` ${nombre}` : ""} 🇨🇺 Estamos disponibles cuando necesites enviar a Cuba.\n\n¿Alguna novedad? 😊`,
        pt: (nombre) =>
            `Oi${nombre ? ` ${nombre}` : ""} 🇨🇺 Estamos disponíveis quando precisar enviar para Cuba.\n\nAlguma novidade? 😊`
    },
    completado_frecuente: {
        es: (nombre) =>
            `¡Gracias${nombre ? ` ${nombre}` : ""}! 🎉 Eres un cliente frecuente — aquí siempre tienes prioridad 💪`,
        pt: (nombre) =>
            `Obrigada${nombre ? ` ${nombre}` : ""}! 🎉 Você é um cliente frequente — aqui sempre tem prioridade 💪`
    }
};

function msg(clave, lang, ...args) {
    return MSGS[clave]?.[lang]?.(...args) || MSGS[clave]?.["es"]?.(...args) || "";
}

// ─────────────────────────────────────────
// TRANSICIONES DE ESTADO CRM
// ─────────────────────────────────────────

/**
 * Todos los estados válidos. El flujo "normal" es:
 * nuevo_cliente → cotizado → esperando_pix → esperando_comprobante → completado
 *
 * abandono se asigna automáticamente cuando los recordatorios
 * no obtienen respuesta.
 */
const ESTADOS_VALIDOS = new Set([
    "nuevo_cliente",
    "cotizado",
    "esperando_pix",
    "esperando_comprobante",
    "completado",
    "abandono",
    // estados internos del bot (compatibilidad con código existente)
    "cotizacion_realizada",
    "aguardando_comprovante",
    "recordatorio_enviado",
    "seleccionando_tarjeta",
    "seleccionando_recarga",
    "aguardando_numero_recarga"
]);

/**
 * Mapa de estados internos del bot → estado CRM.
 * Permite que el resto del código siga usando sus estados
 * sin romper nada, mientras CRM mantiene su propia vista.
 */
const MAPA_CRM = {
    "cotizacion_realizada":      "cotizado",
    "aguardando_comprovante":    "esperando_comprobante",
    "recordatorio_enviado":      "cotizado",
    "seleccionando_tarjeta":     "cotizado",
    "seleccionando_recarga":     "cotizado",
    "aguardando_numero_recarga": "cotizado"
};

function estadoCRM(estadoInterno) {
    return MAPA_CRM[estadoInterno] || estadoInterno;
}

// ─────────────────────────────────────────
// ACTUALIZAR ESTADO CRM EN DB
// ─────────────────────────────────────────

/**
 * Guarda el estado CRM y, opcionalmente, el idioma detectado.
 * No usa COALESCE en estado_crm para poder retrodecer a "cotizado"
 * si el cliente vuelve a cotizar después de un abandono.
 */
async function actualizarEstadoCRM(phone, estadoCrm, lang = null) {
    if (!phone) return;
    try {
        await pool.query(`
            UPDATE customers SET
                estado_crm    = $2,
                idioma        = COALESCE($3, idioma),
                updated_at    = NOW()
            WHERE phone = $1
        `, [phone, estadoCrm, lang]);
    } catch (e) {
        // La columna puede no existir si aún no se corrió la migración
        console.warn("⚠️ CRM: no se pudo actualizar estado_crm:", e.message);
    }
}

/**
 * Marcar como cliente frecuente (3+ operaciones confirmadas).
 */
async function verificarYMarcarFrecuente(phone) {
    try {
        const r = await pool.query(`
            SELECT COUNT(*) AS total
            FROM operations
            WHERE phone = $1 AND status = 'confirmada'
        `, [phone]);
        const total = Number(r.rows[0]?.total || 0);
        if (total >= 3) {
            await pool.query(`
                UPDATE customers SET cliente_frecuente = true, updated_at = NOW()
                WHERE phone = $1
            `, [phone]);
            return true;
        }
        return false;
    } catch (e) {
        console.warn("⚠️ CRM: verificarYMarcarFrecuente:", e.message);
        return false;
    }
}

// ─────────────────────────────────────────
// REGISTRAR PRIMER CONTACTO
// ─────────────────────────────────────────

/**
 * Llamar cuando llega el primer mensaje de un número.
 * Si el cliente ya existe, no hace nada.
 */
async function registrarPrimerContacto(phone, nombre, lang) {
    try {
        const existe = await pool.query(
            "SELECT phone, estado_crm FROM customers WHERE phone = $1",
            [phone]
        );
        if (existe.rows.length === 0) {
            // guardarCliente se encargará del INSERT;
            // aquí solo necesitamos asegurar estado_crm
            return;
        }
        const actual = existe.rows[0].estado_crm;
        if (!actual) {
            await actualizarEstadoCRM(phone, "nuevo_cliente", lang);
        } else if (lang) {
            // Al menos guardar el idioma si ya existía
            await pool.query(
                "UPDATE customers SET idioma = COALESCE($2, idioma) WHERE phone = $1",
                [phone, lang]
            );
        }
    } catch (e) {
        console.warn("⚠️ CRM: registrarPrimerContacto:", e.message);
    }
}

// ─────────────────────────────────────────
// EVENTOS CRM (llamar desde openai.js)
// ─────────────────────────────────────────

async function onCotizacion(phone, lang) {
    await actualizarEstadoCRM(phone, "cotizado", lang);
}

async function onPIXEnviado(phone, lang) {
    await actualizarEstadoCRM(phone, "esperando_pix", lang);
}

async function onComprobanteRecibido(phone, lang) {
    await actualizarEstadoCRM(phone, "esperando_comprobante", lang);
}

async function onOperacionCompletada(phone, lang, nombre) {
    await actualizarEstadoCRM(phone, "completado", lang);
    const esFrecuente = await verificarYMarcarFrecuente(phone);
    if (esFrecuente) {
        try {
            await enviarMensaje(phone, msg("completado_frecuente", lang, nombre?.split(" ")[0]));
        } catch (_) {}
    }
}

// ─────────────────────────────────────────
// RECORDATORIOS AUTOMÁTICOS
// ─────────────────────────────────────────

/**
 * Ejecutar cada 15 minutos desde index.js.
 * Tres ondas de recuperación:
 *   1) 30 min post-cotización (sin que haya recibido el PIX)
 *   2) 24 h  post-cotización (sin cierre)
 *   3) 7 d   sin actividad   (reactivación suave)
 */
async function ejecutarRecordatorios() {
    try {
        await onda30min();
        await onda24h();
        await onda7d();
    } catch (e) {
        console.error("❌ CRM recordatorios:", e.message);
    }
}

// ── Onda 1: 30 minutos ──────────────────

async function onda30min() {
    const r = await pool.query(`
        SELECT phone, nombre, ultimo_monto, idioma
        FROM customers
        WHERE estado_crm = 'cotizado'
          AND ultimo_monto > 0
          AND fecha_cotizacion < NOW() - INTERVAL '30 minutes'
          AND fecha_cotizacion > NOW() - INTERVAL '2 hours'
          AND (ultima_interaccion IS NULL OR ultima_interaccion < NOW() - INTERVAL '25 minutes')
          AND (ultimo_recordatorio IS NULL OR ultimo_recordatorio < NOW() - INTERVAL '25 minutes')
    `);

    for (const c of r.rows) {
        try {
            const lang   = c.idioma === "pt" ? "pt" : "es";
            const nombre = c.nombre ? c.nombre.split(" ")[0] : null;
            await enviarMensaje(c.phone, msg("recuperar_30m", lang, nombre, c.ultimo_monto));
            await marcarRecordatorio(c.phone, "recuperar_30m");
            console.log(`🔔 [CRM 30m] → ${c.phone}`);
        } catch (e) {
            console.error(`❌ CRM 30m ${c.phone}:`, e.message);
        }
    }
}

// ── Onda 2: 24 horas ────────────────────

async function onda24h() {
    const r = await pool.query(`
        SELECT phone, nombre, idioma
        FROM customers
        WHERE estado_crm IN ('cotizado', 'esperando_pix')
          AND fecha_cotizacion < NOW() - INTERVAL '24 hours'
          AND fecha_cotizacion > NOW() - INTERVAL '48 hours'
          AND (ultimo_recordatorio IS NULL OR ultimo_recordatorio < NOW() - INTERVAL '23 hours')
    `);

    for (const c of r.rows) {
        try {
            const lang   = c.idioma === "pt" ? "pt" : "es";
            const nombre = c.nombre ? c.nombre.split(" ")[0] : null;
            await enviarMensaje(c.phone, msg("recuperar_24h", lang, nombre));
            await marcarRecordatorio(c.phone, "recuperar_24h");
            // Si ya mandamos 24h y no responde → abandono
            await actualizarEstadoCRM(c.phone, "abandono");
            console.log(`🔔 [CRM 24h] → ${c.phone}`);
        } catch (e) {
            console.error(`❌ CRM 24h ${c.phone}:`, e.message);
        }
    }
}

// ── Onda 3: 7 días ──────────────────────

async function onda7d() {
    const r = await pool.query(`
        SELECT phone, nombre, idioma
        FROM customers
        WHERE estado_crm = 'abandono'
          AND ultima_interaccion < NOW() - INTERVAL '7 days'
          AND (ultimo_recordatorio IS NULL OR ultimo_recordatorio < NOW() - INTERVAL '7 days')
    `);

    for (const c of r.rows) {
        try {
            const lang   = c.idioma === "pt" ? "pt" : "es";
            const nombre = c.nombre ? c.nombre.split(" ")[0] : null;
            await enviarMensaje(c.phone, msg("recuperar_7d", lang, nombre));
            await marcarRecordatorio(c.phone, "recuperar_7d");
            console.log(`🔔 [CRM 7d] → ${c.phone}`);
        } catch (e) {
            console.error(`❌ CRM 7d ${c.phone}:`, e.message);
        }
    }
}

// ── Helpers ─────────────────────────────

async function marcarRecordatorio(phone, tipo) {
    try {
        await pool.query(`
            UPDATE customers SET
                ultimo_recordatorio      = NOW(),
                tipo_ultimo_recordatorio = $2,
                updated_at               = NOW()
            WHERE phone = $1
        `, [phone, tipo]);
    } catch (e) {
        console.warn("⚠️ CRM: marcarRecordatorio:", e.message);
    }
}

// ─────────────────────────────────────────
// ESTADÍSTICAS CRM (para dashboard)
// ─────────────────────────────────────────

async function obtenerEstadisticasCRM() {
    try {
        const r = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE estado_crm = 'nuevo_cliente')           AS nuevos,
                COUNT(*) FILTER (WHERE estado_crm = 'cotizado')                AS cotizados,
                COUNT(*) FILTER (WHERE estado_crm = 'esperando_pix')           AS esperando_pix,
                COUNT(*) FILTER (WHERE estado_crm = 'esperando_comprobante')   AS esperando_comprobante,
                COUNT(*) FILTER (WHERE estado_crm = 'completado')              AS completados,
                COUNT(*) FILTER (WHERE estado_crm = 'abandono')                AS abandonos,
                COUNT(*) FILTER (WHERE cliente_frecuente = true)               AS frecuentes,
                COUNT(*) FILTER (
                    WHERE estado_crm = 'completado'
                    AND updated_at > NOW() - INTERVAL '24 hours'
                )                                                               AS cierres_hoy,
                -- Conversión: completados / (cotizados + esperando_pix + completado + abandono)
                ROUND(
                    COUNT(*) FILTER (WHERE estado_crm = 'completado') * 100.0 /
                    NULLIF(COUNT(*) FILTER (WHERE estado_crm IN (
                        'cotizado','esperando_pix','esperando_comprobante','completado','abandono'
                    )), 0)
                , 1) AS conversion_pct
            FROM customers
        `);
        return r.rows[0] || {};
    } catch (e) {
        console.error("❌ CRM estadísticas:", e.message);
        return {};
    }
}

// ─────────────────────────────────────────
// MIGRACIÓN SQL (ejecutar UNA vez en NeonDB)
// ─────────────────────────────────────────

/**
 * Agrega las columnas CRM a la tabla customers si no existen.
 * Se llama automáticamente al arrancar el servidor.
 */
async function migrarColumnasCRM() {
    const columnas = [
        ["estado_crm",               "VARCHAR(40)  DEFAULT 'nuevo_cliente'"],
        ["idioma",                   "VARCHAR(2)   DEFAULT 'es'"],
        ["cliente_frecuente",        "BOOLEAN      DEFAULT false"],
        ["ultimo_recordatorio",      "TIMESTAMPTZ"],
        ["tipo_ultimo_recordatorio", "VARCHAR(20)"],
        ["fecha_cotizacion",         "TIMESTAMPTZ"],  // ya puede existir
    ];

    for (const [col, def] of columnas) {
        try {
            await pool.query(`
                ALTER TABLE customers
                ADD COLUMN IF NOT EXISTS ${col} ${def}
            `);
        } catch (e) {
            // Ignorar "already exists" en Postgres sin IF NOT EXISTS soporte
            if (!e.message.includes("already exists")) {
                console.warn(`⚠️ CRM migración columna ${col}:`, e.message);
            }
        }
    }

    // Rellenar estado_crm en filas antiguas
    try {
        await pool.query(`
            UPDATE customers
            SET estado_crm = 'completado'
            WHERE estado_crm IS NULL
              AND phone IN (
                  SELECT DISTINCT phone FROM operations WHERE status = 'confirmada'
              )
        `);
        await pool.query(`
            UPDATE customers
            SET estado_crm = 'nuevo_cliente'
            WHERE estado_crm IS NULL
        `);
    } catch (e) {
        console.warn("⚠️ CRM migración datos:", e.message);
    }

    console.log("✅ CRM: columnas migradas");
}

// ─────────────────────────────────────────

module.exports = {
    // Detección de idioma
    detectarIdioma,
    idioma,

    // Eventos
    registrarPrimerContacto,
    onCotizacion,
    onPIXEnviado,
    onComprobanteRecibido,
    onOperacionCompletada,

    // Estado CRM
    actualizarEstadoCRM,
    estadoCRM,

    // Recordatorios
    ejecutarRecordatorios,

    // Estadísticas
    obtenerEstadisticasCRM,

    // Migración
    migrarColumnasCRM
};
