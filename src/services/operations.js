const pool = require("../../db");

// =====================
// AGREGAR OPERACIÓN
// =====================

async function agregarOperacion(data) {
    try {
        const result = await pool.query(`
            INSERT INTO operations (
                phone,
                nombre,
                monto,
                cup,
                tarjeta,
                titular,
                banco,
                tipo,
                status,
                created_at
            )
            VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,'pendiente',NOW()
            )
            RETURNING *
        `, [
            data.phone || "Sin teléfono",
            data.nombre || "Cliente",
            Number(data.monto || 0),
            Number(data.cup || 0),
            data.tarjeta || "",
            data.titular || "",
            data.banco || "",
            data.tipo || "brl_cup"
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
            UPDATE operations
            SET
                status = 'confirmada',
                confirmed_at = NOW()
            WHERE id = $1
            RETURNING *
        `, [id]);

        if (result.rows.length === 0) {
            console.log(`❌ ID no encontrado: ${id}`);
            return false;
        }

        const operacion = result.rows[0];
        console.log(`✅ Operación CONFIRMADA: ${id}`);
        return operacion;

    } catch (err) {
        console.error("❌ Error confirmando operación:", err.message);
        return false;
    }
}

// =====================
// OBTENER TODAS
// =====================

async function obtenerTodas() {
    try {
        const result = await pool.query(`
            SELECT *
            FROM operations
            ORDER BY created_at DESC
        `);
        return result.rows;
    } catch (err) {
        console.error("❌ Error obteniendo operaciones:", err.message);
        return [];
    }
}

// =====================
// ESTADÍSTICAS
// =====================

async function obtenerEstadisticas() {
    try {
        const total = await pool.query(`
            SELECT COUNT(*) AS total
            FROM operations
            WHERE status='confirmada'
        `);

        const volumen = await pool.query(`
            SELECT COALESCE(SUM(monto),0) AS volumen
            FROM operations
            WHERE status='confirmada'
        `);

        const pendientes = await pool.query(`
            SELECT COUNT(*) AS pendientes
            FROM operations
            WHERE status='pendiente'
        `);

        return {
            totalOperaciones: Number(total.rows[0].total),
            volumenTotal: Number(volumen.rows[0].volumen),
            pendientes: Number(pendientes.rows[0].pendientes)
        };

    } catch (err) {
        console.error("❌ Error obteniendo estadísticas:", err.message);
        return {
            totalOperaciones: 0,
            volumenTotal: 0,
            pendientes: 0
        };
    }
}

module.exports = {
    agregarOperacion,
    confirmarOperacion,
    obtenerTodas,
    obtenerEstadisticas
};
