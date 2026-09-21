"use strict";

// ─────────────────────────────────────────────────────────
// CRM DE ENTREGAS — entrega de efectivo en Cuba (CUP/USD)
//
// Completamente separado de "operations" a nivel de datos (no es un
// filtro visual sobre la misma tabla). Las transferencias NUNCA tocan
// este archivo ni las tablas "entregas" / "entregas_pagos" /
// "entregas_historial".
//
// Reglas duras del negocio (NO romper):
//   - El ID (E-XXXX) es único e inmutable, generado por una secuencia
//     de PostgreSQL — nunca se recalcula ni se reutiliza.
//   - La fecha de creación nunca se modifica.
//   - Estado de entrega y estado de pago son independientes entre sí.
//   - NUNCA se calcula automáticamente cuánto pagar al contacto, ni se
//     convierte CUP/USD a USDT, ni se fija una tasa. El pago es
//     puramente un registro histórico que el usuario llena a mano.
//   - El envejecimiento (días pendiente) nunca cambia el estado solo.
// ─────────────────────────────────────────────────────────

const pool = require("../../db");
const { log } = require("../utils/structured-logger");

// =====================
// HISTORIAL (interno)
// =====================

async function registrarHistorial(entregaId, evento) {
    try {
        await pool.query(
            "INSERT INTO entregas_historial (entrega_id, evento) VALUES ($1, $2)",
            [entregaId, evento]
        );
    } catch (err) {
        console.error("❌ Error registrando historial de entrega:", err.message);
    }
}

async function obtenerHistorialDe(entregaId) {
    try {
        const result = await pool.query(
            "SELECT * FROM entregas_historial WHERE entrega_id = $1 ORDER BY created_at ASC",
            [entregaId]
        );
        return result.rows;
    } catch (err) {
        console.error("❌ Error obteniendo historial de entrega:", err.message);
        return [];
    }
}

// =====================
// CREAR ENTREGA
// =====================
// Genera el código E-XXXX de forma atómica (secuencia dedicada de
// PostgreSQL) y crea el registro. data.operationId puede apuntar a la
// fila hermana en "operations" (se sigue creando en paralelo por
// decisión del negocio), solo como referencia cruzada — nunca se lee
// desde ahí para nada del flujo de entrega.
async function agregarEntrega(data) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const seq = await client.query("SELECT nextval('entregas_codigo_seq') AS n");
        const codigo = `E-${seq.rows[0].n}`;

        const result = await client.query(`
            INSERT INTO entregas (
                codigo, operation_id, ref_web, phone, cliente_nombre,
                telefono_entrega, cantidad, moneda, modalidad,
                provincia, municipio, direccion, referencia, observaciones,
                estado_entrega, estado_pago
            ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PENDIENTE','NO_APLICA'
            ) RETURNING *
        `, [
            codigo,
            data.operationId     || null,
            data.refWeb          || null,
            data.phone           || "Sin teléfono",
            data.clienteNombre   || "Cliente",
            data.telefonoEntrega || null,
            Number(data.cantidad || 0),
            (data.moneda || "CUP").toUpperCase(),
            data.modalidad       || "EFECTIVO",
            data.provincia       || null,
            data.municipio       || null,
            data.direccion       || null,
            data.referencia      || null,
            data.observaciones   || null
        ]);

        await client.query("COMMIT");
        const entrega = result.rows[0];
        await registrarHistorial(entrega.id, `${entrega.codigo} creada`);
        console.log(`📦 Entrega creada: ${entrega.codigo}`);
        log("DELIVERY_CREATED", { entregaId: entrega.id, codigo: entrega.codigo, moneda: entrega.moneda, phone: entrega.phone });
        return entrega;
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("❌ Error creando entrega:", err.message);
        return null;
    } finally {
        client.release();
    }
}

// =====================
// CONSULTAS
// =====================

async function obtenerEntregaPorId(id) {
    try {
        const result = await pool.query("SELECT * FROM entregas WHERE id = $1", [id]);
        return result.rows[0] || null;
    } catch (err) {
        console.error("❌ Error obteniendo entrega:", err.message);
        return null;
    }
}

async function obtenerEntregaPorCodigo(codigo) {
    try {
        const result = await pool.query("SELECT * FROM entregas WHERE codigo = $1", [codigo]);
        return result.rows[0] || null;
    } catch (err) {
        console.error("❌ Error obteniendo entrega por código:", err.message);
        return null;
    }
}

// Evita duplicados si el cliente reenvía el mismo pedido de la calculadora.
async function buscarEntregaPorRefWeb(ref) {
    if (!ref) return null;
    try {
        const result = await pool.query("SELECT * FROM entregas WHERE ref_web = $1 LIMIT 1", [ref]);
        return result.rows[0] || null;
    } catch (err) {
        console.error("❌ Error buscando ref_web en entregas:", err.message);
        return null;
    }
}

// Listado con filtros — todos opcionales (sección 9 del CRM: ID, cliente,
// teléfono, fecha, provincia/localidad, CUP/USD, estado de entrega, estado
// de pago). Se usa tanto para el dashboard como para los filtros rápidos.
async function obtenerEntregas(filtros = {}) {
    try {
        const condiciones = [];
        const valores = [];
        let i = 1;

        // Búsqueda genérica (usada por el buscador simple del dashboard): un
        // mismo texto que puede calzar con el código, el cliente, cualquiera
        // de los dos teléfonos o la provincia/municipio.
        if (filtros.q) {
            condiciones.push(`(
                codigo ILIKE $${i} OR cliente_nombre ILIKE $${i} OR
                phone ILIKE $${i} OR telefono_entrega ILIKE $${i} OR
                provincia ILIKE $${i} OR municipio ILIKE $${i}
            )`);
            valores.push(`%${filtros.q}%`);
            i++;
        }
        if (filtros.codigo) {
            condiciones.push(`codigo ILIKE $${i++}`);
            valores.push(`%${filtros.codigo}%`);
        }
        if (filtros.cliente) {
            condiciones.push(`cliente_nombre ILIKE $${i++}`);
            valores.push(`%${filtros.cliente}%`);
        }
        if (filtros.telefono) {
            condiciones.push(`(phone ILIKE $${i} OR telefono_entrega ILIKE $${i})`);
            valores.push(`%${filtros.telefono}%`);
            i++;
        }
        if (filtros.fechaDesde) {
            condiciones.push(`created_at >= $${i++}`);
            valores.push(filtros.fechaDesde);
        }
        if (filtros.fechaHasta) {
            condiciones.push(`created_at <= $${i++}`);
            valores.push(filtros.fechaHasta);
        }
        if (filtros.provincia) {
            condiciones.push(`(provincia ILIKE $${i} OR municipio ILIKE $${i})`);
            valores.push(`%${filtros.provincia}%`);
            i++;
        }
        if (filtros.moneda) {
            condiciones.push(`moneda = $${i++}`);
            valores.push(filtros.moneda.toUpperCase());
        }
        if (filtros.estadoEntrega) {
            condiciones.push(`estado_entrega = $${i++}`);
            valores.push(filtros.estadoEntrega.toUpperCase());
        }
        if (filtros.estadoPago) {
            condiciones.push(`estado_pago = $${i++}`);
            valores.push(filtros.estadoPago.toUpperCase());
        }

        const where = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";
        const result = await pool.query(
            `SELECT * FROM entregas ${where} ORDER BY created_at DESC`,
            valores
        );
        return result.rows;
    } catch (err) {
        console.error("❌ Error obteniendo entregas:", err.message);
        return [];
    }
}

// =====================
// ESTADO DE ENTREGA
// =====================
// PENDIENTE → ENTREGADO. Al confirmar, el pago al contacto pasa
// automáticamente de NO_APLICA a PENDIENTE_DE_PAGO (sección 5 del CRM).
// El WHERE estado_entrega='PENDIENTE' evita reabrir una entrega ya
// cerrada (ENTREGADO o CANCELADO) por error o doble clic.
async function marcarEntregado(id, usuario) {
    try {
        const result = await pool.query(`
            UPDATE entregas
            SET estado_entrega = 'ENTREGADO',
                fecha_entrega  = NOW(),
                entregado_por  = $2,
                estado_pago    = CASE WHEN estado_pago = 'NO_APLICA' THEN 'PENDIENTE_DE_PAGO' ELSE estado_pago END,
                updated_at     = NOW()
            WHERE id = $1 AND estado_entrega = 'PENDIENTE'
            RETURNING *
        `, [id, usuario || null]);
        if (result.rows.length === 0) return null;
        const entrega = result.rows[0];
        await registrarHistorial(
            entrega.id,
            `${entrega.codigo} marcada ENTREGADO${usuario ? ` por ${usuario}` : ""} — pago al contacto: PENDIENTE DE PAGO`
        );
        console.log(`✅ Entrega ${entrega.codigo} marcada ENTREGADO`);
        log("DELIVERY_COMPLETED", { entregaId: entrega.id, codigo: entrega.codigo });
        return entrega;
    } catch (err) {
        console.error("❌ Error marcando entrega como ENTREGADO:", err.message);
        return null;
    }
}

async function marcarCancelado(id, motivo) {
    try {
        const result = await pool.query(`
            UPDATE entregas
            SET estado_entrega = 'CANCELADO', updated_at = NOW()
            WHERE id = $1 AND estado_entrega = 'PENDIENTE'
            RETURNING *
        `, [id]);
        if (result.rows.length === 0) return null;
        const entrega = result.rows[0];
        await registrarHistorial(entrega.id, `${entrega.codigo} CANCELADA${motivo ? `: ${motivo}` : ""}`);
        console.log(`🚫 Entrega ${entrega.codigo} cancelada`);
        return entrega;
    } catch (err) {
        console.error("❌ Error cancelando entrega:", err.message);
        return null;
    }
}

// =====================
// PAGO AL CONTACTO (individual o agrupado)
// =====================
// IMPORTANTE: esto es un registro histórico puro. Nunca valida ni
// calcula si "cantidadEnviada" corresponde a las cantidades entregadas,
// nunca convierte moneda, nunca fija una tasa. Solo entregas que están
// realmente en PENDIENTE_DE_PAGO se marcan como PAGADO — un ID que no
// califica (ya pagado, cancelado o aún no entregado) se ignora en
// silencio en vez de forzarlo.
async function registrarPago(entregaIds, datos = {}) {
    if (!Array.isArray(entregaIds) || entregaIds.length === 0) return null;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const seq = await client.query("SELECT nextval('entregas_pago_codigo_seq') AS n");
        const codigo = `P-${String(seq.rows[0].n).padStart(3, "0")}`;

        const pagoResult = await client.query(`
            INSERT INTO entregas_pagos (codigo, cantidad_enviada, moneda_pago, fecha, txid, observacion)
            VALUES ($1,$2,$3,$4,$5,$6)
            RETURNING *
        `, [
            codigo,
            datos.cantidadEnviada != null ? Number(datos.cantidadEnviada) : null,
            datos.monedaPago   || null,
            datos.fecha        || new Date(),
            datos.txid         || null,
            datos.observacion  || null
        ]);
        const pago = pagoResult.rows[0];

        const updResult = await client.query(`
            UPDATE entregas
            SET estado_pago = 'PAGADO', pago_id = $1, updated_at = NOW()
            WHERE id = ANY($2::int[]) AND estado_pago = 'PENDIENTE_DE_PAGO'
            RETURNING *
        `, [pago.id, entregaIds]);

        await client.query("COMMIT");

        for (const entrega of updResult.rows) {
            await registrarHistorial(entrega.id, `Pago ${pago.codigo} registrado — ${entrega.codigo} → PAGADO`);
        }

        console.log(`💵 Pago ${pago.codigo} registrado (${updResult.rows.length} entrega/s)`);
        return { pago, entregas: updResult.rows };
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("❌ Error registrando pago de entregas:", err.message);
        return null;
    } finally {
        client.release();
    }
}

// Reabrir un pago (P-008) y ver exactamente qué entregas incluyó.
async function obtenerPago(codigo) {
    try {
        const pagoResult = await pool.query("SELECT * FROM entregas_pagos WHERE codigo = $1", [codigo]);
        const pago = pagoResult.rows[0];
        if (!pago) return null;
        const entregasResult = await pool.query(
            "SELECT * FROM entregas WHERE pago_id = $1 ORDER BY id",
            [pago.id]
        );
        return { ...pago, entregas: entregasResult.rows };
    } catch (err) {
        console.error("❌ Error obteniendo pago:", err.message);
        return null;
    }
}

// =====================
// DASHBOARD DEL CRM DE EFECTIVO (sección 8)
// =====================
// Totales de CUP y USD siempre por separado, nunca convertidos a USDT.
async function obtenerEstadisticasEntregas() {
    try {
        const result = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE estado_entrega = 'PENDIENTE') AS pendientes_count,
                COALESCE(SUM(cantidad) FILTER (WHERE estado_entrega = 'PENDIENTE' AND moneda = 'CUP'), 0) AS pendientes_cup,
                COALESCE(SUM(cantidad) FILTER (WHERE estado_entrega = 'PENDIENTE' AND moneda = 'USD'), 0) AS pendientes_usd,

                COUNT(*) FILTER (WHERE estado_entrega = 'ENTREGADO' AND estado_pago = 'PENDIENTE_DE_PAGO') AS entregadas_count,
                COALESCE(SUM(cantidad) FILTER (WHERE estado_entrega = 'ENTREGADO' AND estado_pago = 'PENDIENTE_DE_PAGO' AND moneda = 'CUP'), 0) AS entregadas_cup,
                COALESCE(SUM(cantidad) FILTER (WHERE estado_entrega = 'ENTREGADO' AND estado_pago = 'PENDIENTE_DE_PAGO' AND moneda = 'USD'), 0) AS entregadas_usd,

                COUNT(*) FILTER (WHERE estado_pago = 'PAGADO') AS pagadas_count,
                COUNT(*) FILTER (WHERE estado_entrega = 'CANCELADO') AS canceladas_count
            FROM entregas
        `);
        const r = result.rows[0];
        return {
            pendientes: { count: Number(r.pendientes_count), cup: Number(r.pendientes_cup), usd: Number(r.pendientes_usd) },
            entregadas: { count: Number(r.entregadas_count), cup: Number(r.entregadas_cup), usd: Number(r.entregadas_usd) },
            pagadas:    Number(r.pagadas_count),
            canceladas: Number(r.canceladas_count)
        };
    } catch (err) {
        console.error("❌ Error obteniendo estadísticas de entregas:", err.message);
        return {
            pendientes: { count: 0, cup: 0, usd: 0 },
            entregadas: { count: 0, cup: 0, usd: 0 },
            pagadas: 0,
            canceladas: 0
        };
    }
}

// =====================
// AVISO DE ATRASO (sección 10 del CRM)
// =====================
// Detecta entregas PENDIENTE que llevan más de "horasUmbral" sin resolverse,
// para avisar por WhatsApp. Nunca cambia el estado — eso sigue siendo
// manual, tal como pide el documento ("no modificar automáticamente su
// estado"). Solo trae las que no se avisaron en las últimas 24h, para no
// mandar el mismo aviso muchas veces seguidas si el job corre cada pocas
// horas; si sigue pendiente al día siguiente, vuelve a avisar.
async function obtenerEntregasAtrasadasSinAvisar(horasUmbral) {
    try {
        const result = await pool.query(`
            SELECT * FROM entregas
            WHERE estado_entrega = 'PENDIENTE'
              AND created_at < NOW() - ($1 || ' hours')::interval
              AND (ultimo_aviso_atraso IS NULL OR ultimo_aviso_atraso < NOW() - INTERVAL '24 hours')
            ORDER BY created_at ASC
        `, [horasUmbral]);
        return result.rows;
    } catch (err) {
        console.error("❌ Error obteniendo entregas atrasadas:", err.message);
        return [];
    }
}

// =====================
// AVISOS AUTOMÁTICOS AL CLIENTE (mañana/tarde) -- src/services/entregas-avisos.js
// Distinto del aviso de atraso de arriba (que avisa al ADMIN cuando una
// entrega lleva 48h+ sin resolver). Esto avisa al CLIENTE, dos veces al
// día como máximo, mientras la entrega siga PENDIENTE y no esté
// desactivado individualmente (avisos_automaticos).
// =====================

// `franja` es "manana" | "tarde" -- valor interno fijo, nunca viene de
// input externo, por eso es seguro interpolar el nombre de columna.
const COLUMNA_POR_FRANJA = Object.freeze({
    manana: "ultimo_aviso_manana_at",
    tarde: "ultimo_aviso_tarde_at"
});

// Trae las entregas PENDIENTE, con avisos_automaticos=true, que todavía no
// recibieron el aviso de esta franja en el día de calendario de Brasil que
// empieza en `inicioDiaUTC` (ver src/utils/timezone.js:inicioDiaSaoPauloUTC).
async function obtenerEntregasPendientesParaAviso(franja, inicioDiaUTC) {
    const columna = COLUMNA_POR_FRANJA[franja];
    if (!columna) throw new Error(`franja inválida: "${franja}"`);
    try {
        const result = await pool.query(`
            SELECT * FROM entregas
            WHERE estado_entrega = 'PENDIENTE'
              AND avisos_automaticos = true
              AND (${columna} IS NULL OR ${columna} < $1)
            ORDER BY created_at ASC
        `, [inicioDiaUTC]);
        return result.rows;
    } catch (err) {
        console.error(`❌ Error obteniendo entregas pendientes para aviso (${franja}):`, err.message);
        return [];
    }
}

async function marcarAvisoEntregaEnviado(id, franja, indicePlantilla) {
    const columna = COLUMNA_POR_FRANJA[franja];
    if (!columna) return;
    try {
        await pool.query(
            `UPDATE entregas SET ${columna} = NOW(), ultimo_aviso_plantilla_idx = $2 WHERE id = $1`,
            [id, indicePlantilla]
        );
    } catch (err) {
        console.error("❌ Error marcando aviso de entrega pendiente:", err.message);
    }
}

// Control ON/OFF individual (sección L) -- nunca cambia estado_entrega ni
// estado_pago, solo si esta entrega puede recibir los avisos automáticos.
async function cambiarAvisosAutomaticos(id, activo) {
    try {
        const r = await pool.query(
            "UPDATE entregas SET avisos_automaticos = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
            [!!activo, id]
        );
        return r.rows[0] || null;
    } catch (err) {
        console.error("❌ Error cambiando avisos_automaticos:", err.message);
        return null;
    }
}

async function marcarAvisoAtrasoEnviado(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    try {
        await pool.query(
            "UPDATE entregas SET ultimo_aviso_atraso = NOW() WHERE id = ANY($1::int[])",
            [ids]
        );
    } catch (err) {
        console.error("❌ Error marcando aviso de atraso:", err.message);
    }
}

// =====================
// TASA USDT (sección 6 del CRM — ayuda de cálculo)
// =====================
// Tasa que Yordanys o su compañera configuran ellos mismos (cuánto CUP y
// cuánto USD equivalen a 1 USDT), SOLO para sugerir el monto en USDT al
// registrar un pago — nunca se aplica sola ni se guarda como definitiva:
// el campo de "cantidad enviada" en registrarPago sigue siendo editable
// a mano, tal como pide la regla dura de "registro histórico puro".
async function obtenerTasasUsdt() {
    try {
        const result = await pool.query("SELECT * FROM entregas_tasas WHERE id = 1");
        return result.rows[0] || { tasa_usdt_cup: 0, tasa_usdt_usd: 0 };
    } catch (err) {
        console.error("❌ Error obteniendo tasas USDT:", err.message);
        return { tasa_usdt_cup: 0, tasa_usdt_usd: 0 };
    }
}

async function actualizarTasasUsdt({ tasaCup, tasaUsd }) {
    try {
        const result = await pool.query(`
            UPDATE entregas_tasas
            SET tasa_usdt_cup = $1, tasa_usdt_usd = $2, updated_at = NOW()
            WHERE id = 1
            RETURNING *
        `, [Number(tasaCup || 0), Number(tasaUsd || 0)]);
        return result.rows[0] || null;
    } catch (err) {
        console.error("❌ Error actualizando tasas USDT:", err.message);
        return null;
    }
}

// ─────────────────────────────────────────
// MENSAJE AL ADMIN — entrega marcada como ENTREGADO (index.js, ruta
// POST /admin/entregas/:id/entregado). Función pura extraída para poder
// probar su formato sin levantar el servidor (mismo patrón que
// src/services/operation-messages.js). Mismo criterio visual aprobado
// para Operadores de Transferencias: emoji + etiqueta en negrita, un solo
// icono por dato -- 💵 (no 💰) porque esto siempre es efectivo.
// ─────────────────────────────────────────
function mensajeEntregaMarcada(entrega) {
    return `✅ Entrega ${entrega.codigo} marcada como ENTREGADO.\n\n` +
        `👤 *Cliente:* ${entrega.cliente_nombre}\n` +
        `💵 *Entregado:* ${Number(entrega.cantidad).toLocaleString("es-ES")} ${entrega.moneda}\n\n` +
        `💵 *Pago al contacto:* PENDIENTE DE PAGO`;
}

module.exports = {
    agregarEntrega,
    obtenerEntregaPorId,
    obtenerEntregaPorCodigo,
    mensajeEntregaMarcada,
    buscarEntregaPorRefWeb,
    obtenerEntregas,
    marcarEntregado,
    marcarCancelado,
    registrarPago,
    obtenerPago,
    obtenerHistorialDe,
    obtenerEstadisticasEntregas,
    obtenerEntregasAtrasadasSinAvisar,
    marcarAvisoAtrasoEnviado,
    obtenerEntregasPendientesParaAviso,
    marcarAvisoEntregaEnviado,
    cambiarAvisosAutomaticos,
    obtenerTasasUsdt,
    actualizarTasasUsdt
};
