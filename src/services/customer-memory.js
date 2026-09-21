
const pool = require("../../db");
const { filtrarNoBloqueados } = require("./blocked-numbers");

// ─────────────────────────────────────────
// GUARDAR / ACTUALIZAR CLIENTE
// Columnas actuales en NeonDB (18) + 2 nuevas = 20
// ─────────────────────────────────────────

async function guardarCliente({
    phone,
    nombre              = null,
    monto               = null,
    tipo                = null,
    banco               = null,
    tarjeta             = null,
    titular             = null,
    bancoDetectado      = null,
    estado              = null,
    fechaEstado         = null,
    fechaCotizacion     = null,
    fechaPix            = null,
    tarjetas            = null,
    comprobantePendiente = null,
    valorComprobante    = null,
    ultimaInteraccion   = null,
    saludoEnviado       = null,   // nuevo — saludo único
    lastResponseId      = null,   // nuevo — Responses API
    ultimoAvisoEntrega  = null,   // nuevo — para no repetir la explicación de entrega seguido
    ultimaPregunta      = null,   // nuevo — contexto conversacional corto (migración 0011)
    ultimasOpciones     = null    // nuevo — idem, array de opciones mostradas junto a ultimaPregunta
}) {
    if (!phone) return null;

    // contexto_actualizado_at se estampa SOLO cuando se está grabando una
    // pregunta nueva -- así el TTL corto (ver reglas-bot.js) cuenta desde
    // la última vez que el bot realmente preguntó algo, no desde
    // cualquier otro guardarCliente() sin relación (ej. guardar el monto).
    const contextoActualizadoAt = ultimaPregunta !== null ? new Date().toISOString() : null;

    try {
        const existe = await pool.query(
            "SELECT phone FROM customers WHERE phone = $1",
            [phone]
        );

        if (existe.rows.length === 0) {
            await pool.query(`
                INSERT INTO customers (
                    phone, nombre, ultimo_monto, tipo_favorito,
                    banco_favorito, tarjeta_frecuente, titular_frecuente,
                    banco_detectado, estado, fecha_estado, fecha_cotizacion,
                    fecha_pix, created_at, updated_at,
                    tarjetas, comprobante_pendiente, valor_comprobante,
                    ultima_interaccion, saludo_enviado, last_response_id, ultimo_aviso_entrega,
                    ultima_pregunta, ultimas_opciones, contexto_actualizado_at
                ) VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                    NOW(), NOW(),
                    $13,$14,$15,$16,$17,$18,$19,$20,$21,$22
                )
            `, [
                phone, nombre, monto, tipo, banco, tarjeta, titular,
                bancoDetectado, estado, fechaEstado, fechaCotizacion, fechaPix,
                tarjetas ? JSON.stringify(tarjetas) : null,
                comprobantePendiente, valorComprobante, ultimaInteraccion,
                saludoEnviado, lastResponseId, ultimoAvisoEntrega,
                ultimaPregunta, ultimasOpciones ? JSON.stringify(ultimasOpciones) : null, contextoActualizadoAt
            ]);

        } else {
            await pool.query(`
                UPDATE customers SET
                    nombre               = COALESCE($2,  nombre),
                    ultimo_monto         = COALESCE($3,  ultimo_monto),
                    tipo_favorito        = COALESCE($4,  tipo_favorito),
                    banco_favorito       = COALESCE($5,  banco_favorito),
                    tarjeta_frecuente    = COALESCE($6,  tarjeta_frecuente),
                    titular_frecuente    = COALESCE($7,  titular_frecuente),
                    banco_detectado      = COALESCE($8,  banco_detectado),
                    estado               = COALESCE($9,  estado),
                    fecha_estado         = COALESCE($10, fecha_estado),
                    fecha_cotizacion     = COALESCE($11, fecha_cotizacion),
                    fecha_pix            = COALESCE($12, fecha_pix),
                    tarjetas             = COALESCE($13, tarjetas),
                    comprobante_pendiente= COALESCE($14, comprobante_pendiente),
                    valor_comprobante    = COALESCE($15, valor_comprobante),
                    ultima_interaccion   = COALESCE($16, ultima_interaccion),
                    saludo_enviado       = COALESCE($17, saludo_enviado),
                    last_response_id     = COALESCE($18, last_response_id),
                    ultimo_aviso_entrega = COALESCE($19, ultimo_aviso_entrega),
                    ultima_pregunta          = COALESCE($20, ultima_pregunta),
                    ultimas_opciones         = COALESCE($21, ultimas_opciones),
                    contexto_actualizado_at  = COALESCE($22, contexto_actualizado_at),
                    updated_at           = NOW()
                WHERE phone = $1
            `, [
                phone, nombre, monto, tipo, banco, tarjeta, titular,
                bancoDetectado, estado, fechaEstado, fechaCotizacion, fechaPix,
                tarjetas ? JSON.stringify(tarjetas) : null,
                comprobantePendiente, valorComprobante, ultimaInteraccion,
                saludoEnviado, lastResponseId, ultimoAvisoEntrega,
                ultimaPregunta, ultimasOpciones ? JSON.stringify(ultimasOpciones) : null, contextoActualizadoAt
            ]);
        }

        return true;

    } catch (err) {
        console.error("❌ guardarCliente:", err.message);
        return false;
    }
}

// ─────────────────────────────────────────
// LIMPIAR SESIÓN
// Resetea estado y campos de flujo a NULL directamente
// (sin COALESCE para que sí pueda nullear)
// ─────────────────────────────────────────

async function limpiarSesionDB(phone) {
    if (!phone) return false;
    try {
        await pool.query(`
            UPDATE customers SET
                estado                = NULL,
                fecha_estado          = NULL,
                fecha_pix             = NULL,
                comprobante_pendiente = NULL,
                valor_comprobante     = NULL,
                last_response_id      = NULL,
                -- Limpiar datos de la operación anterior para evitar que
                -- se reutilicen en una nueva cotización del mismo cliente
                ultimo_monto          = NULL,
                tipo_favorito         = NULL,
                tarjeta_frecuente     = NULL,
                titular_frecuente     = NULL,
                banco_favorito        = NULL,
                -- Contexto conversacional corto (migración 0011): una
                -- sesión cerrada no debe dejar una "pregunta pendiente"
                -- colgada para la próxima conversación.
                ultima_pregunta          = NULL,
                ultimas_opciones         = NULL,
                contexto_actualizado_at  = NULL,
                updated_at            = NOW()
            WHERE phone = $1
        `, [phone]);
        return true;
    } catch (err) {
        console.error("❌ limpiarSesionDB:", err.message);
        return false;
    }
}

// Limpia SOLO el contexto conversacional corto (sin tocar estado, monto,
// tarjeta, etc.) — se usa cuando esa pregunta puntual ya se respondió
// (ej. el cliente ya eligió la tarjeta) y no tiene sentido dejarla
// vigente para el próximo mensaje.
async function limpiarContextoCorto(phone) {
    if (!phone) return false;
    try {
        await pool.query(`
            UPDATE customers SET
                ultima_pregunta         = NULL,
                ultimas_opciones        = NULL,
                contexto_actualizado_at = NULL
            WHERE phone = $1
        `, [phone]);
        return true;
    } catch (err) {
        console.error("❌ limpiarContextoCorto:", err.message);
        return false;
    }
}

// ─────────────────────────────────────────
// OBTENER CLIENTE
// ─────────────────────────────────────────

async function obtenerCliente(phone) {
    try {
        const result = await pool.query(
            "SELECT * FROM customers WHERE phone = $1",
            [phone]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error("❌ obtenerCliente:", err.message);
        return null;
    }
}

// ─────────────────────────────────────────
// TODOS LOS CLIENTES
// ─────────────────────────────────────────

async function obtenerTodos() {
    try {
        const result = await pool.query(
            "SELECT * FROM customers ORDER BY updated_at DESC"
        );
        return result.rows;
    } catch (err) {
        console.error("❌ obtenerTodos:", err.message);
        return [];
    }
}

// ─────────────────────────────────────────
// ELIMINAR CLIENTE
// ─────────────────────────────────────────

async function eliminarCliente(phone) {
    try {
        await pool.query("DELETE FROM customers WHERE phone = $1", [phone]);
        return true;
    } catch (err) {
        console.error("❌ eliminarCliente:", err.message);
        return false;
    }
}

module.exports = {
    guardarCliente,
    limpiarSesionDB,
    limpiarContextoCorto,
    obtenerCliente,
    obtenerTodos,
    eliminarCliente,
    marcarSaludoPendiente,
    obtenerSaludosPendientes,
    limpiarSaludoPendiente
};

// ── Saludo matutino: marcar / listar / limpiar ──
async function marcarSaludoPendiente(phone) {
    try {
        await pool.query("UPDATE customers SET saludo_pendiente = true WHERE phone = $1", [phone]);
    } catch (err) { console.error("❌ marcarSaludoPendiente:", err.message); }
}
async function obtenerSaludosPendientes() {
    try {
        const r = await pool.query("SELECT phone, nombre FROM customers WHERE saludo_pendiente = true");
        // Filtrado en JS (no en el SQL) a propósito: filtrarNoBloqueados() ya
        // degrada solo a "no bloqueado" si blocked_numbers no existe todavía
        // (migración 0010 sin correr), sin romper el saludo matutino.
        return await filtrarNoBloqueados(r.rows || []);
    } catch (err) { console.error("❌ obtenerSaludosPendientes:", err.message); return []; }
}
async function limpiarSaludoPendiente(phone) {
    try {
        await pool.query("UPDATE customers SET saludo_pendiente = false WHERE phone = $1", [phone]);
    } catch (err) { console.error("❌ limpiarSaludoPendiente:", err.message); }
}
