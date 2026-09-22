"use strict";

// ─────────────────────────────────────────────────────────
// CRM DE RECUPERACIÓN — FASE 1 (solo lectura)
//
// Identifica clientes con alta probabilidad de haber querido operar pero
// que no terminaron, para revisión manual en el dashboard. Esta fase NO
// envía nada -- ver public/dashboard.html ("🎯 Clientes por recuperar").
//
// Deliberadamente NO usa customers.estado_crm como criterio de inclusión
// (auditoría: de 99 clientes marcados 'abandono', 49 ya tenían una
// operación real completada/confirmada -- estado_crm queda desactualizado).
// customers.estado (estado conversacional interno del bot) es la señal
// confiable de "hasta dónde llegó" porque se limpia (limpiarSesion) en el
// mismo paso en que se crea una fila real en operations. operations es la
// verdad financiera que decide si el intento realmente quedó abandonado.
//
// Tampoco se trata "abandono" como un tercer conjunto de candidatos: la
// auditoría mostró que el 100% de los 'abandono' sin operación real siguen
// teniendo customers.estado no nulo -- es la MISMA población, marcada por
// el job automático (crm.js:onda24h) sin verificar operations. Tratarlo
// como fuente aparte duplicaría candidatos.
// ─────────────────────────────────────────────────────────

const pool = require("../../db");

// Mapeo directo dato→etiqueta, sin inferencia -- mismo tipo_favorito que ya
// guardan cotizarBRL/cotizarUSD/cotizarMLC (cotizacion-flow.js) y el bloque
// de recargas.
const ETIQUETAS_SERVICIO = {
    brl_cup:               "CUP transferencia",
    usd_clasica:            "USD Clásica",
    usd_prepago:            "USD Prepago/Internacional",
    usd_pendiente_tipo:     "USD — tipo pendiente",
    mlc:                    "MLC",
    cup_efectivo:           "CUP efectivo",
    usd_efectivo:           "USD efectivo",
    recarga_nacional:       "Recarga nacional",
    recarga_internacional:  "Recarga internacional"
};

function etiquetaServicio(tipoFavorito) {
    return ETIQUETAS_SERVICIO[tipoFavorito] || tipoFavorito || "Sin definir";
}

// customers.estado -- únicos dos estados que representan un intento
// comercial real sin operación creada todavía (ver comentario de arriba).
// aguardando_comprovante = llegó hasta el PIX (más avanzado) -> alta.
// cotizacion_realizada   = cotizó, nunca llegó al PIX -> media.
const PRIORIDAD_POR_ESTADO = {
    aguardando_comprovante: "alta",
    cotizacion_realizada:   "media"
};

function prioridadDeEstado(estado) {
    return PRIORIDAD_POR_ESTADO[estado] || null;
}

const UN_DIA_MS     = 24 * 60 * 60 * 1000;
const SIETE_DIAS_MS = 7 * UN_DIA_MS;

// Clasificación visual por ANTIGÜEDAD (duración transcurrida desde el
// intento hasta ahora) -- no depende de huso horario: "más de 7 días"
// es la misma cantidad de milisegundos en cualquier zona. Los cortes de
// calendario (día de São Paulo) solo aplican a métricas tipo "hoy"
// (ver crm.js:obtenerEstadisticasCRM), no a una duración acumulada.
function antiguedadDe(fechaIntento, ahora = new Date()) {
    if (!fechaIntento) return null;
    const ms = ahora.getTime() - new Date(fechaIntento).getTime();
    if (ms < 0) return "reciente";
    if (ms < UN_DIA_MS) return "reciente";
    if (ms < SIETE_DIAS_MS) return "1-7 dias";
    return "recuperacion"; // > 7 días
}

// Predicado único de "es candidato recuperable ahora mismo" -- compartido
// entre el listado (obtenerCandidatosRecuperacion) y la re-validación de un
// solo teléfono (obtenerCandidatoRecuperablePorTelefono, usada por el
// endpoint de preview de mensaje para no confiar en un candidato viejo o
// manipulado que el frontend mande de vuelta). Nunca se duplica esta
// lógica -- un único WHERE, dos formas de llamarlo.
const PREDICADO_CANDIDATO = `
    cu.estado IN ('aguardando_comprovante', 'cotizacion_realizada')
    AND COALESCE(cu.fecha_estado, cu.fecha_cotizacion) IS NOT NULL
    -- Mínimo 2 horas de antigüedad -- mismo umbral que ya usa el flujo de
    -- PIX (DOS_HORAS en shared.js) para no interrumpir una conversación
    -- todavía en curso.
    AND COALESCE(cu.fecha_estado, cu.fecha_cotizacion) < NOW() - INTERVAL '2 hours'
    -- Exclusión 1: bloqueados.
    AND NOT EXISTS (SELECT 1 FROM blocked_numbers b WHERE b.phone = cu.phone)
    -- Exclusión 2: pausa humana activa (mismo campo que usa
    -- webhook-guard.js:enPausaHumana).
    AND (cu.pausa_hasta IS NULL OR cu.pausa_hasta < NOW())
    -- Exclusión 3: ya existe una operación real (confirmada o completada)
    -- creada DESPUÉS de este intento -- el cliente sí terminó comprando
    -- (por este canal o por otro), el intento viejo quedó obsoleto y no
    -- debe generar un candidato. Una operación ANTERIOR al intento actual
    -- NO excluye (fue un pedido distinto, ya cerrado, que no tiene que ver
    -- con este).
    AND NOT EXISTS (
        SELECT 1 FROM operations o
        WHERE o.phone = cu.phone
          AND o.status IN ('confirmada','completada')
          AND o.created_at > COALESCE(cu.fecha_estado, cu.fecha_cotizacion)
    )
`;

const SELECT_CANDIDATO = `
    SELECT
        cu.phone, cu.nombre, cu.estado, cu.tipo_favorito, cu.ultimo_monto,
        COALESCE(cu.fecha_estado, cu.fecha_cotizacion) AS fecha_intento,
        cu.estado_crm, cu.ultimo_recordatorio, cu.tipo_ultimo_recordatorio
    FROM customers cu
`;

function mapearFilaCandidato(row) {
    return {
        phone:                  row.phone,
        nombre:                 row.nombre,
        estado:                 row.estado,
        prioridad:              prioridadDeEstado(row.estado),
        servicio:               etiquetaServicio(row.tipo_favorito),
        tipoFavorito:           row.tipo_favorito,
        ultimoMonto:            row.ultimo_monto !== null ? Number(row.ultimo_monto) : null,
        fechaIntento:           row.fecha_intento,
        antiguedad:             antiguedadDe(row.fecha_intento),
        estadoCrm:              row.estado_crm,
        ultimoRecordatorio:     row.ultimo_recordatorio,
        tipoUltimoRecordatorio: row.tipo_ultimo_recordatorio
    };
}

// Consulta única, con todos los filtros de exclusión aplicados en el propio
// SQL -- el backend nunca devuelve un candidato que el frontend tenga que
// terminar de filtrar (ver punto D del pedido: "no confiar en datos
// calculados por frontend").
async function obtenerCandidatosRecuperacion() {
    try {
        const r = await pool.query(`
            ${SELECT_CANDIDATO}
            WHERE ${PREDICADO_CANDIDATO}
            ORDER BY COALESCE(cu.fecha_estado, cu.fecha_cotizacion) ASC
        `);
        return r.rows.map(mapearFilaCandidato);
    } catch (e) {
        console.error("❌ Error obteniendo candidatos de recuperación:", e.message);
        return [];
    }
}

// Re-valida UN teléfono puntual contra el mismo predicado -- usada antes de
// generar cualquier preview de mensaje. Un candidato que el frontend
// recuerde de una carga vieja (ya operó, se bloqueó, entró en pausa, etc.)
// nunca pasa esto, aunque el frontend lo siga mostrando en pantalla.
async function obtenerCandidatoRecuperablePorTelefono(phone) {
    if (!phone) return null;
    try {
        const r = await pool.query(`
            ${SELECT_CANDIDATO}
            WHERE cu.phone = $1 AND ${PREDICADO_CANDIDATO}
        `, [phone]);
        return r.rows[0] ? mapearFilaCandidato(r.rows[0]) : null;
    } catch (e) {
        console.error("❌ Error re-validando candidato de recuperación:", e.message);
        return null;
    }
}

module.exports = {
    obtenerCandidatosRecuperacion,
    obtenerCandidatoRecuperablePorTelefono,
    etiquetaServicio,
    prioridadDeEstado,
    antiguedadDe
};
