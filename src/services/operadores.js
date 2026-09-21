"use strict";

// ─────────────────────────────────────────────────────────
// OPERADORES DE TRANSFERENCIAS
//
// Trabajadores que ejecutan Transferencias (CUP/USD/MLC) reales una vez
// que el pago del cliente ya fue verificado por el admin. EXCLUSIVAMENTE
// Transferencias -- Recargas (Operaciones de Recargas) y Entregas de
// efectivo (CRM de Entregas) NUNCA pasan por este módulo, cada uno
// conserva su propio flujo independiente.
//
// migrations/0014_operadores_transferencias.sql (tabla operadores) y
// migrations/0015_operador_avisos.sql (trazabilidad + idempotencia).
// ─────────────────────────────────────────────────────────

const pool = require("../../db");
const { enviarSeguro, fmt } = require("../flows/shared");

const MODALIDADES_VALIDAS = Object.freeze(["cup", "usd", "mlc", "todos"]);

// Mapa tipo REAL de operación -> modalidad conceptual de Transferencias.
// Fuente de verdad de qué tipos existen: src/services/calculator.js
// (brl_cup/usd_clasica/usd_prepago/usd_pendiente_tipo/mlc -- vía WhatsApp)
// y src/flows/pedido-web-flow.js (cup_transferencia/usd_transferencia/
// mlc_transferencia -- vía la calculadora web, mismas 3 modalidades por un
// canal de entrada distinto). cup_efectivo/usd_efectivo son Entregas
// (CRM propio) y recarga_nacional/recarga_internacional son Recargas
// (Operaciones de Recargas) -- deliberadamente NO están en este mapa, así
// que modalidadDeTipo() devuelve null para ellos y nunca se consideran
// Transferencias.
const TIPO_A_MODALIDAD = Object.freeze({
    brl_cup: "cup",
    cup_transferencia: "cup",
    usd_clasica: "usd",
    usd_prepago: "usd",
    usd_pendiente_tipo: "usd",
    usd_transferencia: "usd",
    mlc: "mlc",
    mlc_transferencia: "mlc"
});

function modalidadDeTipo(tipo) {
    return TIPO_A_MODALIDAD[tipo] || null;
}

// Único criterio de "esto es una Transferencia" para todo el módulo de
// Operadores -- igual patrón que esOperacionDeRecarga() en dashboard.html.
function esOperacionDeTransferencia(operacion) {
    return modalidadDeTipo(operacion?.tipo) !== null;
}

function normalizarModalidades(lista) {
    if (!Array.isArray(lista)) return [];
    const set = new Set(
        lista.map(m => String(m || "").trim().toLowerCase()).filter(m => MODALIDADES_VALIDAS.includes(m))
    );
    return [...set];
}

// ── CRUD ──

async function listarOperadores() {
    try {
        const r = await pool.query("SELECT * FROM operadores ORDER BY activo DESC, nombre ASC");
        return r.rows;
    } catch (e) {
        console.error("❌ listarOperadores:", e.message);
        return [];
    }
}

async function crearOperador({ nombre, telefono, modalidades, activo }) {
    const nombreLimpio = String(nombre || "").trim();
    const telefonoLimpio = String(telefono || "").replace(/\D/g, "");
    if (!nombreLimpio || !telefonoLimpio) return { error: "Falta nombre o teléfono" };

    const modalidadesLimpias = normalizarModalidades(modalidades);
    if (modalidadesLimpias.length === 0) return { error: "Selecciona al menos una modalidad" };

    try {
        const r = await pool.query(
            `INSERT INTO operadores (nombre, telefono, activo, modalidades)
             VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
            [nombreLimpio, telefonoLimpio, activo !== false, JSON.stringify(modalidadesLimpias)]
        );
        return { operador: r.rows[0] };
    } catch (e) {
        console.error("❌ crearOperador:", e.message);
        return { error: "Error de base de datos" };
    }
}

async function editarOperador(id, { nombre, telefono, modalidades, activo }) {
    try {
        const actual = await pool.query("SELECT * FROM operadores WHERE id = $1", [id]);
        if (actual.rows.length === 0) return { error: "Operador no encontrado" };

        const nombreFinal = nombre !== undefined ? String(nombre).trim() : actual.rows[0].nombre;
        const telefonoFinal = telefono !== undefined ? String(telefono).replace(/\D/g, "") : actual.rows[0].telefono;
        const modalidadesFinal = modalidades !== undefined ? normalizarModalidades(modalidades) : actual.rows[0].modalidades;
        const activoFinal = activo !== undefined ? !!activo : actual.rows[0].activo;

        if (!nombreFinal || !telefonoFinal) return { error: "Falta nombre o teléfono" };
        if (!Array.isArray(modalidadesFinal) || modalidadesFinal.length === 0) return { error: "Selecciona al menos una modalidad" };

        const r = await pool.query(
            `UPDATE operadores SET
                nombre = $1, telefono = $2, activo = $3, modalidades = $4::jsonb, updated_at = NOW()
             WHERE id = $5 RETURNING *`,
            [nombreFinal, telefonoFinal, activoFinal, JSON.stringify(modalidadesFinal), id]
        );
        return { operador: r.rows[0] };
    } catch (e) {
        console.error("❌ editarOperador:", e.message);
        return { error: "Error de base de datos" };
    }
}

// Activar/desactivar es un caso particular de editar, pero se expone
// aparte porque es la acción que más se usa día a día ("quién trabaja
// hoy") -- nunca borra el registro, solo cambia `activo`.
async function cambiarActivo(id, activo) {
    try {
        const r = await pool.query(
            "UPDATE operadores SET activo = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
            [!!activo, id]
        );
        return r.rows[0] || null;
    } catch (e) {
        console.error("❌ cambiarActivo (operador):", e.message);
        return null;
    }
}

// ── Selección de operadores elegibles para una modalidad ──

async function operadoresActivosParaModalidad(modalidad) {
    try {
        const r = await pool.query(
            `SELECT * FROM operadores
             WHERE activo = true
               AND (modalidades @> '["todos"]'::jsonb OR modalidades @> $1::jsonb)
             ORDER BY nombre ASC`,
            [JSON.stringify([modalidad])]
        );
        return r.rows;
    } catch (e) {
        console.error("❌ operadoresActivosParaModalidad:", e.message);
        return [];
    }
}

// ── Datos reales de la operación para el mensaje del operador ──
//
// operations.monto/operations.cup tienen semántica DISTINTA según el tipo
// real (verificado leyendo cada flujo de creación):
//   - brl_cup / cup_transferencia:        monto = R$ pagado,   cup = CUP destino
//   - usd_clasica/usd_prepago/usd_pendiente_tipo: monto = USD destino, cup = R$ pagado
//   - usd_transferencia / mlc_transferencia: monto = R$ pagado, cup = destino
//     (src/flows/pedido-web-flow.js guarda siempre el destino en `cup`,
//     sin importar la moneda -- ver el fix en ese mismo archivo. Antes
//     solo lo guardaba cuando moneda==='CUP', dejando `cup=0` para
//     USD/MLC; operaciones históricas anteriores a ese fix pueden no
//     tener este dato -- por eso `destino` sigue siendo null si cup es 0).
//   - mlc:                                 monto = MLC destino, cup = R$ pagado
// Nunca se inventa un valor que no esté realmente en la fila.
// `fmt()` (src/flows/shared.js, ya usado en todo el resto de la app para
// montos hacia WhatsApp) solo agrega separador de miles para lectura --
// nunca toca el valor real de operacion.monto/cup, ni lo que ya se
// guardó/calculó en `operations`. Puramente visual.
function datosMontoOperador(operacion) {
    const tipo = operacion?.tipo;
    switch (tipo) {
        case "brl_cup":
        case "cup_transferencia":
            return { pagado: `R$${fmt(operacion.monto)}`, destino: `${fmt(operacion.cup)} CUP` };
        case "usd_clasica":
        case "usd_prepago":
        case "usd_pendiente_tipo":
            return { pagado: `R$${fmt(operacion.cup)}`, destino: `${fmt(operacion.monto)} USD` };
        case "usd_transferencia":
            return { pagado: `R$${fmt(operacion.monto)}`, destino: operacion.cup ? `${fmt(operacion.cup)} USD` : null };
        case "mlc":
            return { pagado: `R$${fmt(operacion.cup)}`, destino: `${fmt(operacion.monto)} MLC` };
        case "mlc_transferencia":
            return { pagado: `R$${fmt(operacion.monto)}`, destino: operacion.cup ? `${fmt(operacion.cup)} MLC` : null };
        default:
            return null;
    }
}

// Mensaje mínimo para EJECUTAR la transferencia -- el CRM ya conserva el
// resto de la información completa (monto en R$, banco, tipo exacto,
// comprobante, etc.), así que aquí solo va lo que el operador necesita
// para actuar: a quién, cuánto/en qué moneda y a qué tarjeta/cuenta. La
// moneda del destino ya queda implícita en "Enviar: X CUP/USD/MLC" (ver
// datosMontoOperador), por eso no hace falta una línea de "Tipo" aparte.
function construirMensajeOperador(operacion) {
    const modalidad = modalidadDeTipo(operacion.tipo);
    const datos = datosMontoOperador(operacion);
    if (!modalidad || !datos) return null;

    const lineas = [
        `🔔 *Nueva transferencia #${operacion.id}*`,
        "",
        `👤 *Cliente:* ${operacion.titular || operacion.nombre || "-"}`
    ];
    if (datos.destino) lineas.push(`💰 *Enviar:* ${datos.destino}`);
    if (operacion.tarjeta) lineas.push(`💳 *Tarjeta:* ${operacion.tarjeta}`);

    return lineas.join("\n");
}

// ── Trazabilidad + idempotencia (migración 0015) ──
//
// INSERT ... ON CONFLICT DO NOTHING RETURNING id: si la fila se inserta,
// esta llamada "ganó" el derecho a avisar (primera vez para este par
// operador+operación); si no se insertó (ya existía), es un retry/
// repetición -- nunca se vuelve a enviar el WhatsApp.
async function reclamarAviso(operadorId, operationId) {
    try {
        const r = await pool.query(
            `INSERT INTO operador_avisos (operador_id, operation_id)
             VALUES ($1, $2) ON CONFLICT (operador_id, operation_id) DO NOTHING
             RETURNING id`,
            [operadorId, operationId]
        );
        return r.rows.length > 0;
    } catch (e) {
        console.error("❌ reclamarAviso:", e.message);
        // Ante la duda (ej. tabla todavía no migrada) NO se envía -- nunca
        // se arriesga a mandar un aviso sin poder registrar que se mandó.
        return false;
    }
}

async function obtenerTrazabilidad(operationId) {
    try {
        const r = await pool.query(
            `SELECT oa.operador_id, o.nombre AS operador_nombre, oa.operation_id, oa.enviado_at
             FROM operador_avisos oa
             JOIN operadores o ON o.id = oa.operador_id
             WHERE oa.operation_id = $1
             ORDER BY oa.enviado_at ASC`,
            [operationId]
        );
        return r.rows;
    } catch (e) {
        console.error("❌ obtenerTrazabilidad:", e.message);
        return [];
    }
}

// ── Punto de entrada: avisar a todos los operadores elegibles ──
//
// Se llama SOLO al CONFIRMAR el pago (admin verifica manualmente, ver
// index.js /admin/confirmar-operacion/:id) -- nunca al crear la operación
// (todavía 'pendiente', pago sin verificar: mandar al operador a ejecutar
// la transferencia en ese momento violaría el invariante "comprobante
// leído ≠ pago confirmado" que rige todo el sistema).
async function notificarOperadoresDeOperacion(operacion) {
    const modalidad = modalidadDeTipo(operacion?.tipo);
    if (!modalidad) return { notificados: [] }; // no es Transferencia -- nunca avisa Recargas/Entregas

    const mensaje = construirMensajeOperador(operacion);
    if (!mensaje) return { notificados: [] };

    const operadores = await operadoresActivosParaModalidad(modalidad);
    const notificados = [];
    for (const op of operadores) {
        const gano = await reclamarAviso(op.id, operacion.id);
        if (!gano) continue; // ya se había avisado a este operador -- idempotencia
        await enviarSeguro(op.telefono, mensaje);
        notificados.push(op.id);
    }
    return { notificados };
}

module.exports = {
    MODALIDADES_VALIDAS,
    modalidadDeTipo,
    esOperacionDeTransferencia,
    normalizarModalidades,
    listarOperadores,
    crearOperador,
    editarOperador,
    cambiarActivo,
    operadoresActivosParaModalidad,
    datosMontoOperador,
    construirMensajeOperador,
    reclamarAviso,
    obtenerTrazabilidad,
    notificarOperadoresDeOperacion
};
