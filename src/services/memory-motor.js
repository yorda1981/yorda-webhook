"use strict";

/**
 * memory-motor.js — Motor de Memoria Comercial de Yorda
 *
 * Aprende patrones de cada cliente:
 * - monto habitual
 * - frecuencia de envío
 * - horario de contacto
 * - velocidad de decisión (rápido/normal/lento)
 *
 * Se ejecuta en background — nunca bloquea el flujo principal.
 */

const pool = require("../../db");

// ─────────────────────────────────────────
// ACTUALIZAR PATRONES (llamar al completar operación)
// ─────────────────────────────────────────

async function actualizarPatrones(phone) {
    try {
        // 1. Monto más frecuente
        const montoRes = await pool.query(`
            SELECT monto, COUNT(*) as freq
            FROM operations
            WHERE phone = $1 AND status = 'confirmada'
            GROUP BY monto
            ORDER BY freq DESC, monto DESC
            LIMIT 1
        `, [phone]);
        const patronMonto = montoRes.rows[0]?.monto || null;

        // 2. Frecuencia promedio entre operaciones (días)
        const frecRes = await pool.query(`
            SELECT ROUND(AVG(diff_dias)) as promedio
            FROM (
                SELECT EXTRACT(EPOCH FROM (created_at - LAG(created_at) OVER (ORDER BY created_at))) / 86400 as diff_dias
                FROM operations
                WHERE phone = $1 AND status = 'confirmada'
            ) sub
            WHERE diff_dias IS NOT NULL
        `, [phone]);
        const patronFrecuencia = frecRes.rows[0]?.promedio || null;

        // 3. Hora habitual de contacto
        const horaRes = await pool.query(`
            SELECT EXTRACT(HOUR FROM ultima_interaccion) as hora, COUNT(*) as freq
            FROM customers
            WHERE phone = $1
            GROUP BY hora
            ORDER BY freq DESC
            LIMIT 1
        `, [phone]);
        // hora no tiene historial per-mensaje, usamos updated_at de operations
        const horaOpsRes = await pool.query(`
            SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Sao_Paulo') as hora, COUNT(*) as freq
            FROM operations
            WHERE phone = $1
            GROUP BY hora
            ORDER BY freq DESC
            LIMIT 1
        `, [phone]);
        const patronHorario = horaOpsRes.rows[0]?.hora || null;

        // 4. Total operaciones confirmadas
        const totalRes = await pool.query(`
            SELECT COUNT(*) as total, MIN(created_at) as primera
            FROM operations
            WHERE phone = $1 AND status = 'confirmada'
        `, [phone]);
        const totalOps    = Number(totalRes.rows[0]?.total || 0);
        const primeraOp   = totalRes.rows[0]?.primera || null;

        await pool.query(`
            UPDATE customers SET
                patron_monto      = COALESCE($2, patron_monto),
                patron_frecuencia = COALESCE($3, patron_frecuencia),
                patron_horario    = COALESCE($4, patron_horario),
                total_operaciones = $5,
                fecha_primera_op  = COALESCE($6, fecha_primera_op),
                updated_at        = NOW()
            WHERE phone = $1
        `, [phone, patronMonto, patronFrecuencia, patronHorario, totalOps, primeraOp]);

        console.log(`🧠 Patrones actualizados: ${phone} | monto:${patronMonto} | frec:${patronFrecuencia}d | hora:${patronHorario}h`);
    } catch (e) {
        console.error("❌ memory-motor actualizarPatrones:", e.message);
    }
}

// ─────────────────────────────────────────
// ACTUALIZAR VELOCIDAD DE DECISIÓN
// Llamar cuando el cliente paga (medir tiempo desde cotización)
// ─────────────────────────────────────────

async function actualizarVelocidadDecision(phone, fechaCotizacion) {
    if (!fechaCotizacion) return;
    try {
        const minutos = (Date.now() - new Date(fechaCotizacion).getTime()) / 60000;
        let perfil;
        if (minutos < 10)       perfil = "rapido";
        else if (minutos < 60)  perfil = "normal";
        else                    perfil = "lento";

        await pool.query(`
            UPDATE customers SET
                perfil_decision = $2,
                updated_at      = NOW()
            WHERE phone = $1
        `, [phone, perfil]);
    } catch (e) {
        console.error("❌ memory-motor velocidad:", e.message);
    }
}

// ─────────────────────────────────────────
// GENERAR ANTICIPACIÓN (qué sugerir proactivamente)
// ─────────────────────────────────────────

async function generarAnticipacion(phone) {
    try {
        const r = await pool.query(`
            SELECT
                patron_monto, patron_frecuencia, patron_horario,
                perfil_decision, total_operaciones,
                tarjeta_frecuente, titular_frecuente, banco_detectado,
                tipo_favorito, score_confianza, cliente_frecuente,
                ultima_interaccion, fecha_primera_op
            FROM customers
            WHERE phone = $1
        `, [phone]);

        if (!r.rows.length) return null;
        const c = r.rows[0];

        const anticipacion = {
            sugerirMonto:     null,
            sugerirRepetir:   false,
            diasDesdeUltima:  null,
            proximaOp:        null,
            mensajeContexto:  null
        };

        // Monto habitual conocido
        if (c.patron_monto && Number(c.patron_monto) > 0) {
            anticipacion.sugerirMonto = c.patron_monto;
        }

        // Días desde última interacción
        if (c.ultima_interaccion) {
            anticipacion.diasDesdeUltima = Math.floor(
                (Date.now() - new Date(c.ultima_interaccion).getTime()) / (1000 * 60 * 60 * 24)
            );
        }

        // Predicción de próxima operación
        if (c.patron_frecuencia && c.ultima_interaccion) {
            const diasHastaProxima = Number(c.patron_frecuencia) - (anticipacion.diasDesdeUltima || 0);
            if (diasHastaProxima <= 3 && diasHastaProxima >= 0) {
                anticipacion.proximaOp = "pronto"; // el cliente suele operar en los próximos días
            }
        }

        // Cliente que suele repetir el mismo monto
        if (c.patron_monto && c.total_operaciones >= 3) {
            anticipacion.sugerirRepetir = true;
        }

        return anticipacion;
    } catch (e) {
        console.error("❌ memory-motor anticipacion:", e.message);
        return null;
    }
}

// ─────────────────────────────────────────
// RESUMEN DEL PERFIL (para logs y dashboard)
// ─────────────────────────────────────────

async function obtenerPerfilCliente(phone) {
    try {
        const r = await pool.query(`
            SELECT
                nombre, score_confianza, ops_completadas, total_operaciones,
                patron_monto, patron_frecuencia, patron_horario,
                perfil_decision, cliente_frecuente, tipo_favorito,
                tarjeta_frecuente, banco_detectado,
                fecha_primera_op, ultima_interaccion
            FROM customers WHERE phone = $1
        `, [phone]);
        return r.rows[0] || null;
    } catch { return null; }
}

// ─────────────────────────────────────────
// ESTADÍSTICAS GLOBALES (para dashboard)
// ─────────────────────────────────────────

async function obtenerEstadisticasMotor() {
    try {
        const r = await pool.query(`
            SELECT
                AVG(patron_monto)::INTEGER      AS monto_promedio_global,
                AVG(patron_frecuencia)::INTEGER AS frecuencia_promedio_dias,
                COUNT(*) FILTER (WHERE perfil_decision = 'rapido') AS clientes_rapidos,
                COUNT(*) FILTER (WHERE perfil_decision = 'normal') AS clientes_normales,
                COUNT(*) FILTER (WHERE perfil_decision = 'lento')  AS clientes_lentos,
                COUNT(*) FILTER (WHERE score_confianza >= 80)      AS clientes_vip,
                COUNT(*) FILTER (WHERE total_operaciones >= 1)     AS clientes_activos
            FROM customers
        `);
        return r.rows[0] || {};
    } catch { return {}; }
}

module.exports = {
    actualizarPatrones,
    actualizarVelocidadDecision,
    generarAnticipacion,
    obtenerPerfilCliente,
    obtenerEstadisticasMotor
};
