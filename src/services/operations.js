const pool = require("../../db");

// =====================
// AGREGAR OPERACIÓN
// =====================

async function agregarOperacion(data) {
    try {
        const result = await pool.query(`
            INSERT INTO operations (
                phone, nombre, monto, cup,
                tarjeta, titular, banco, tipo,
                status, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendiente',NOW())
            RETURNING *
        `, [
            data.phone   || "Sin teléfono",
            data.nombre  || "Cliente",
            Number(data.monto  || 0),
            Number(data.cup    || 0),
            data.tarjeta || "",
            data.titular || "",
            data.banco   || "",
            data.tipo    || "brl_cup"
        ]);
        console.log(`⏳ Operación PENDIENTE: R$${data.monto}`);
        return result.rows[0];
    } catch (err) {
        console.error("❌ Error agregando operación:", err.message);
        return null;
    }
}

// =====================
// CONFIRMAR OPERACIÓN
// =====================

async function confirmarOperacion(id) {
    try {
        const result = await pool.query(`
            UPDATE operations SET status = 'confirmada', confirmed_at = NOW()
            WHERE id = $1 RETURNING *
        `, [id]);
        if (result.rows.length === 0) return false;
        console.log(`✅ Operación CONFIRMADA: ${id}`);
        return result.rows[0];
    } catch (err) {
        console.error("❌ Error confirmando operación:", err.message);
        return false;
    }
}

// =====================
// OBTENER TODAS — solo para dashboard
// =====================

async function obtenerTodas() {
    try {
        const result = await pool.query("SELECT * FROM operations ORDER BY created_at DESC");
        return result.rows;
    } catch (err) {
        console.error("❌ Error obteniendo operaciones:", err.message);
        return [];
    }
}

// =====================
// ÚLTIMA OPERACIÓN DE UN CLIENTE
// =====================

async function obtenerUltimaOperacion(phone) {
    try {
        const result = await pool.query(`
            SELECT * FROM operations
            WHERE phone = $1
            ORDER BY id DESC LIMIT 1
        `, [phone]);
        return result.rows[0] || null;
    } catch (err) {
        console.error("❌ Error obteniendo última operación:", err.message);
        return null;
    }
}

// =====================
// OPERACIÓN PENDIENTE DE UN CLIENTE
// =====================

async function obtenerPendienteCliente(phone) {
    try {
        const result = await pool.query(`
            SELECT * FROM operations
            WHERE phone = $1 AND status = 'pendiente'
            ORDER BY id DESC LIMIT 1
        `, [phone]);
        return result.rows[0] || null;
    } catch (err) {
        console.error("❌ Error obteniendo pendiente:", err.message);
        return null;
    }
}

// =====================
// VERIFICAR DUPLICADO
// =====================

async function existeOperacionPendiente(phone, monto) {
    try {
        const result = await pool.query(`
            SELECT id FROM operations
            WHERE phone = $1 AND status = 'pendiente' AND monto = $2
            LIMIT 1
        `, [phone, Number(monto)]);
        return result.rows.length > 0;
    } catch (err) {
        console.error("❌ Error verificando duplicado:", err.message);
        return false;
    }
}

// =====================
// ESTADÍSTICAS
// =====================

async function obtenerEstadisticas() {
    try {
        const result = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE status = 'confirmada') AS total,
                COALESCE(SUM(monto) FILTER (WHERE status = 'confirmada'), 0) AS volumen,
                COUNT(*) FILTER (WHERE status = 'pendiente') AS pendientes
            FROM operations
        `);
        return {
            totalOperaciones: Number(result.rows[0].total),
            volumenTotal:     Number(result.rows[0].volumen),
            pendientes:       Number(result.rows[0].pendientes)
        };
    } catch (err) {
        console.error("❌ Error estadísticas:", err.message);
        return { totalOperaciones: 0, volumenTotal: 0, pendientes: 0 };
    }
}

module.exports = {
    agregarOperacion,
    confirmarOperacion,
    obtenerTodas,
    obtenerUltimaOperacion,
    obtenerPendienteCliente,
    existeOperacionPendiente,
    obtenerEstadisticas
};
