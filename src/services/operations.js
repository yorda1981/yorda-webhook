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
                ref_web, direccion, provincia, municipio,
                referencia_entrega, telefono_entrega, entrega_disponible,
                status, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pendiente',NOW())
            RETURNING *
        `, [
            data.phone   || "Sin teléfono",
            data.nombre  || "Cliente",
            Number(data.monto  || 0),
            Number(data.cup    || 0),
            data.tarjeta || "",
            data.titular || "",
            data.banco   || "",
            data.tipo    || "brl_cup",
            data.refWeb            || null,
            data.direccion         || null,
            data.provincia         || null,
            data.municipio         || null,
            data.referenciaEntrega || null,
            data.telefonoEntrega   || null,
            typeof data.entregaDisponible === "boolean" ? data.entregaDisponible : null
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
// COMPLETAR OPERACIÓN (entrega/transferencia finalizada)
// =====================

async function completarOperacion(id) {
    try {
        const result = await pool.query(`
            UPDATE operations SET status = 'completada', completed_at = NOW()
            WHERE id = $1
            RETURNING *
        `, [id]);
        if (result.rows.length === 0) return null;
        console.log(`🏁 Operación COMPLETADA: ${id}`);
        return result.rows[0];
    } catch (err) {
        console.error("❌ Error completando operación:", err.message);
        return null;
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
// BUSCAR POR REFERENCIA WEB (evita duplicados de la calculadora)
// =====================

async function buscarPorRefWeb(ref) {
    if (!ref) return null;
    try {
        const result = await pool.query("SELECT * FROM operations WHERE ref_web = $1 LIMIT 1", [ref]);
        return result.rows[0] || null;
    } catch (err) {
        console.error("❌ Error buscando ref_web:", err.message);
        return null;
    }
}

// =====================
// ESTADÍSTICAS
// =====================

async function obtenerEstadisticas() {
    try {
        const result = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE status IN ('confirmada','completada')) AS total,
                COALESCE(SUM(monto) FILTER (WHERE status IN ('confirmada','completada')), 0) AS volumen,
                COUNT(*) FILTER (WHERE status = 'pendiente') AS pendientes,
                COUNT(*) FILTER (WHERE status = 'completada') AS completadas
            FROM operations
        `);
        return {
            totalOperaciones: Number(result.rows[0].total),
            volumenTotal:     Number(result.rows[0].volumen),
            pendientes:       Number(result.rows[0].pendientes),
            completadas:      Number(result.rows[0].completadas)
        };
    } catch (err) {
        console.error("❌ Error estadísticas:", err.message);
        return { totalOperaciones: 0, volumenTotal: 0, pendientes: 0, completadas: 0 };
    }
}

// =====================
// CADUCIDAD — operaciones "pendiente" sin verificar en 24h
// =====================

async function expirarOperacionesPendientes() {
    try {
        const result = await pool.query(`
            UPDATE operations
            SET status = 'expirada', updated_at = NOW()
            WHERE status = 'pendiente'
              AND created_at < NOW() - INTERVAL '24 hours'
            RETURNING id, phone, monto
        `);
        if (result.rows.length > 0) {
            console.log(`⏰ ${result.rows.length} operación(es) expiradas por pasar 24h sin verificar`);
        }
        return result.rows;
    } catch (err) {
        console.error("❌ Error expirando operaciones:", err.message);
        return [];
    }
}

module.exports = {
    agregarOperacion,
    confirmarOperacion,
    completarOperacion,
    obtenerTodas,
    obtenerUltimaOperacion,
    obtenerPendienteCliente,
    existeOperacionPendiente,
    buscarPorRefWeb,
    obtenerEstadisticas,
    expirarOperacionesPendientes
};
