const pool = require("../../db");

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
    lastResponseId      = null    // nuevo — Responses API
}) {
    if (!phone) return null;

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
                    ultima_interaccion, saludo_enviado, last_response_id
                ) VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                    NOW(), NOW(),
                    $13,$14,$15,$16,$17,$18
                )
            `, [
                phone, nombre, monto, tipo, banco, tarjeta, titular,
                bancoDetectado, estado, fechaEstado, fechaCotizacion, fechaPix,
                tarjetas ? JSON.stringify(tarjetas) : null,
                comprobantePendiente, valorComprobante, ultimaInteraccion,
                saludoEnviado, lastResponseId
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
                    updated_at           = NOW()
                WHERE phone = $1
            `, [
                phone, nombre, monto, tipo, banco, tarjeta, titular,
                bancoDetectado, estado, fechaEstado, fechaCotizacion, fechaPix,
                tarjetas ? JSON.stringify(tarjetas) : null,
                comprobantePendiente, valorComprobante, ultimaInteraccion,
                saludoEnviado, lastResponseId
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
                updated_at            = NOW()
            WHERE phone = $1
        `, [phone]);
        return true;
    } catch (err) {
        console.error("❌ limpiarSesionDB:", err.message);
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
    obtenerCliente,
    obtenerTodos,
    eliminarCliente
};
