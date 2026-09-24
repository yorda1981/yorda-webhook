"use strict";

const pool = require("../../db");
const { montosTransferencia } = require("./operadores");

const COLUMNAS = Object.freeze({ CUP: "saldo_cup", USD: "saldo_usd", MLC: "saldo_mlc" });

class SaldoInsuficienteError extends Error {
    constructor(moneda, disponible, requerido) {
        const faltante = Math.max(0, requerido - disponible);
        super(`Saldo insuficiente en ${moneda}. Disponible: ${disponible.toFixed(2)} ${moneda}; faltante: ${faltante.toFixed(2)} ${moneda}.`);
        this.name = "SaldoInsuficienteError";
        this.moneda = moneda;
        this.disponible = disponible;
        this.faltante = faltante;
    }
}

function monedaValida(moneda) {
    const normalizada = String(moneda || "").toUpperCase();
    return COLUMNAS[normalizada] ? normalizada : null;
}

async function ajustarSaldo(operadorId, { moneda, monto, tipo }) {
    const monedaFinal = monedaValida(moneda);
    const tipoFinal = String(tipo || "").toLowerCase();
    const cantidad = Number(monto);
    if (!monedaFinal) return { error: "Moneda inválida" };
    if (!Number.isFinite(cantidad) || cantidad === 0) return { error: "El monto debe ser distinto de cero" };
    if (!['carga', 'ajuste'].includes(tipoFinal)) return { error: "Tipo de movimiento inválido" };
    if (tipoFinal === "carga" && cantidad < 0) return { error: "Una carga debe ser positiva" };

    const columna = COLUMNAS[monedaFinal];
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const actual = await client.query(`SELECT ${columna} AS saldo FROM operadores WHERE id = $1 FOR UPDATE`, [operadorId]);
        if (!actual.rows[0]) { await client.query("ROLLBACK"); return { error: "Operador no encontrado" }; }
        const saldoAnterior = Number(actual.rows[0].saldo);
        const saldoPosterior = saldoAnterior + cantidad;
        if (saldoPosterior < 0) { await client.query("ROLLBACK"); return { error: `El ajuste dejaría saldo negativo. Disponible: ${saldoAnterior.toFixed(2)} ${monedaFinal}` }; }
        await client.query(`UPDATE operadores SET ${columna} = $1, updated_at = NOW() WHERE id = $2`, [saldoPosterior, operadorId]);
        const movimiento = await client.query(
            `INSERT INTO operador_movimientos (operador_id, moneda, monto, tipo, saldo_anterior, saldo_posterior)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [operadorId, monedaFinal, cantidad, tipoFinal, saldoAnterior, saldoPosterior]
        );
        await client.query("COMMIT");
        return { movimiento: movimiento.rows[0] };
    } catch (e) {
        await client.query("ROLLBACK");
        throw e;
    } finally { client.release(); }
}

async function listarMovimientos(operadorId, limite = 20) {
    const cantidad = Math.min(50, Math.max(1, Number(limite) || 20));
    const r = await pool.query(
        `SELECT * FROM operador_movimientos WHERE operador_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
        [operadorId, cantidad]
    );
    return r.rows;
}

async function completarConDescuento(operationId, operadorId) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const opResult = await client.query("SELECT * FROM operations WHERE id = $1 FOR UPDATE", [operationId]);
        const operacion = opResult.rows[0];
        if (!operacion || operacion.status !== "confirmada") { await client.query("ROLLBACK"); return null; }
        const transferencia = montosTransferencia(operacion);
        if (!transferencia || !Number.isFinite(transferencia.destino) || transferencia.destino <= 0) {
            await client.query("ROLLBACK");
            return { error: "La operación no tiene una cantidad destino válida" };
        }
        const moneda = transferencia.moneda;
        const columna = COLUMNAS[moneda];
        const operadorResult = await client.query(
            `SELECT id, activo, modalidades, ${columna} AS saldo
             FROM operadores WHERE id = $1 FOR UPDATE`, [operadorId]
        );
        if (!operadorResult.rows[0]) { await client.query("ROLLBACK"); return { error: "Operador no encontrado" }; }
        const operador = operadorResult.rows[0];
        const modalidades = Array.isArray(operador.modalidades) ? operador.modalidades : [];
        const modalidad = moneda.toLowerCase();
        if (!operador.activo) { await client.query("ROLLBACK"); return { error: "El operador seleccionado está inactivo" }; }
        if (!modalidades.includes("todos") && !modalidades.includes(modalidad)) {
            await client.query("ROLLBACK");
            return { error: `El operador seleccionado no gestiona transferencias en ${moneda}` };
        }
        const anterior = Number(operador.saldo);
        const requerido = Number(transferencia.destino);
        if (anterior < requerido) throw new SaldoInsuficienteError(moneda, anterior, requerido);
        const posterior = anterior - requerido;
        await client.query(`UPDATE operadores SET ${columna} = $1, updated_at = NOW() WHERE id = $2`, [posterior, operadorId]);
        await client.query(
            `INSERT INTO operador_movimientos
             (operador_id, moneda, monto, tipo, operation_id, saldo_anterior, saldo_posterior)
             VALUES ($1,$2,$3,'descuento',$4,$5,$6)`,
            [operadorId, moneda, -requerido, operationId, anterior, posterior]
        );
        const completada = await client.query(
            `UPDATE operations SET status = 'completada', completed_at = NOW(), operador_id = $2
             WHERE id = $1 AND status = 'confirmada' RETURNING *`,
            [operationId, operadorId]
        );
        await client.query("COMMIT");
        return { operacion: completada.rows[0] };
    } catch (e) {
        await client.query("ROLLBACK");
        throw e;
    } finally { client.release(); }
}

// Punto único para cualquier flujo futuro/existente que revierta una completada.
// El índice único de reintegro y el bloqueo de la operación garantizan una sola devolución.
async function reintegrarPorReversion(operationId, nuevoEstado = "confirmada") {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const opResult = await client.query("SELECT * FROM operations WHERE id = $1 FOR UPDATE", [operationId]);
        const operacion = opResult.rows[0];
        if (!operacion || operacion.status !== "completada" || !operacion.operador_id) { await client.query("ROLLBACK"); return null; }
        const descuento = await client.query(
            `SELECT * FROM operador_movimientos WHERE operation_id = $1 AND tipo = 'descuento' FOR UPDATE`, [operationId]
        );
        if (!descuento.rows[0]) { await client.query("ROLLBACK"); return null; }
        const yaReintegrado = await client.query(
            `SELECT id FROM operador_movimientos WHERE operation_id = $1 AND tipo = 'reintegro'`, [operationId]
        );
        if (yaReintegrado.rows[0]) { await client.query("ROLLBACK"); return null; }
        const moneda = descuento.rows[0].moneda;
        const cantidad = Math.abs(Number(descuento.rows[0].monto));
        const columna = COLUMNAS[moneda];
        const saldoResult = await client.query(`SELECT ${columna} AS saldo FROM operadores WHERE id = $1 FOR UPDATE`, [operacion.operador_id]);
        const anterior = Number(saldoResult.rows[0].saldo);
        const posterior = anterior + cantidad;
        await client.query(`UPDATE operadores SET ${columna} = $1, updated_at = NOW() WHERE id = $2`, [posterior, operacion.operador_id]);
        await client.query(
            `INSERT INTO operador_movimientos
             (operador_id, moneda, monto, tipo, operation_id, saldo_anterior, saldo_posterior)
             VALUES ($1,$2,$3,'reintegro',$4,$5,$6)`,
            [operacion.operador_id, moneda, cantidad, operationId, anterior, posterior]
        );
        await client.query("UPDATE operations SET status = $2, completed_at = NULL WHERE id = $1", [operationId, nuevoEstado]);
        await client.query("COMMIT");
        return { reintegrado: cantidad, moneda, saldo: posterior };
    } catch (e) {
        await client.query("ROLLBACK");
        throw e;
    } finally { client.release(); }
}

module.exports = { SaldoInsuficienteError, ajustarSaldo, listarMovimientos, completarConDescuento, reintegrarPorReversion };
