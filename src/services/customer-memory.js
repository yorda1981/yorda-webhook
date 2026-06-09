const pool = require("../../db");

// ========================
// SALVAR / ATUALIZAR CLIENTE
// ========================

async function guardarCliente({
    phone,
    nombre = null,
    monto = null,
    tipo = null,
    banco = null,
    tarjeta = null,
    titular = null,
    bancoDetectado = null,
    estado = null,
    fechaEstado = null,
    fechaCotizacion = null,
    fechaPix = null,

    // futuros campos
    tarjetas = null,
    comprobantePendiente = null,
    valorComprobante = null,
    ultimaInteraccion = null
}) {
    if (!phone) return null;

    // ✅ Logs temporales para depuración
    if (tarjetas) {
        console.log("📌 TARJETAS RECIBIDAS:", tarjetas);
    }
    if (comprobantePendiente !== null) {
        console.log("📌 COMPROBANTE PENDIENTE:", comprobantePendiente);
    }
    if (valorComprobante !== null) {
        console.log("📌 VALOR COMPROBANTE:", valorComprobante);
    }
    if (ultimaInteraccion) {
        console.log("📌 ÚLTIMA INTERACCIÓN:", ultimaInteraccion);
    }

    try {
        const existe = await pool.query(
            "SELECT * FROM customers WHERE phone = $1",
            [phone]
        );

        if (existe.rows.length === 0) {
            await pool.query(`
                INSERT INTO customers (
                    phone,
                    nombre,
                    ultimo_monto,
                    tipo_favorito,
                    banco_favorito,
                    tarjeta_frecuente,
                    titular_frecuente,
                    banco_detectado,
                    estado,
                    fecha_estado,
                    fecha_cotizacion,
                    fecha_pix,
                    created_at,
                    updated_at,
                    tarjetas,
                    comprobante_pendiente,
                    valor_comprobante,
                    ultima_interaccion
                )
                VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                    NOW(),
                    NOW(),
                    $13,
                    $14,
                    $15,
                    $16
                )
            `, [
                phone,
                nombre,
                monto,
                tipo,
                banco,
                tarjeta,
                titular,
                bancoDetectado,
                estado,
                fechaEstado,
                fechaCotizacion,
                fechaPix,
                tarjetas ? JSON.stringify(tarjetas) : null,
                comprobantePendiente,
                valorComprobante,
                ultimaInteraccion
            ]);

        } else {
            await pool.query(`
                UPDATE customers
                SET
                    nombre = COALESCE($2,nombre),
                    ultimo_monto = COALESCE($3,ultimo_monto),
                    tipo_favorito = COALESCE($4,tipo_favorito),
                    banco_favorito = COALESCE($5,banco_favorito),
                    tarjeta_frecuente = COALESCE($6,tarjeta_frecuente),
                    titular_frecuente = COALESCE($7,titular_frecuente),
                    banco_detectado = COALESCE($8,banco_detectado),
                    estado = COALESCE($9,estado),
                    fecha_estado = COALESCE($10,fecha_estado),
                    fecha_cotizacion = COALESCE($11,fecha_cotizacion),
                    fecha_pix = COALESCE($12,fecha_pix),
                    tarjetas = COALESCE($13,tarjetas),
                    comprobante_pendiente = COALESCE($14,comprobante_pendiente),
                    valor_comprobante = COALESCE($15,valor_comprobante),
                    ultima_interaccion = COALESCE($16,ultima_interaccion),
                    updated_at = NOW()
                WHERE phone = $1
            `, [
                phone,
                nombre,
                monto,
                tipo,
                banco,
                tarjeta,
                titular,
                bancoDetectado,
                estado,
                fechaEstado,
                fechaCotizacion,
                fechaPix,
                tarjetas ? JSON.stringify(tarjetas) : null,
                comprobantePendiente,
                valorComprobante,
                ultimaInteraccion
            ]);
        }

        return true;

    } catch (err) {
        console.error("❌ Error guardando cliente:", err.message);
        return false;
    }
}

// ========================
// OBTENER CLIENTE
// ========================

async function obtenerCliente(phone) {
    try {
        const result = await pool.query(
            "SELECT * FROM customers WHERE phone = $1",
            [phone]
        );

        const cliente = result.rows[0] || null;
        return cliente;

    } catch (err) {
        console.error("❌ Error obteniendo cliente:", err.message);
        return null;
    }
}

// ========================
// TODOS LOS CLIENTES
// ========================

async function obtenerTodos() {
    try {
        const result = await pool.query(`
            SELECT *
            FROM customers
            ORDER BY updated_at DESC
        `);
        return result.rows;
    } catch (err) {
        console.error("❌ Error obteniendo clientes:", err.message);
        return [];
    }
}

// ========================
// ELIMINAR CLIENTE
// ========================

async function eliminarCliente(phone) {
    try {
        await pool.query(
            "DELETE FROM customers WHERE phone = $1",
            [phone]
        );
        return true;
    } catch (err) {
        console.error("❌ Error eliminando cliente:", err.message);
        return false;
    }
}

module.exports = {
    guardarCliente,
    obtenerCliente,
    obtenerTodos,
    eliminarCliente
};
