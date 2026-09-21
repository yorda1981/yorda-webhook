"use strict";

// ─────────────────────────────────────────
// IDENTIDAD DE COMPROBANTES PIX (imagen o PDF, mismo camino)
//
// INVARIANTE DE SEGURIDAD: COMPROBANTE LEÍDO ≠ DINERO CONFIRMADO. Todo lo
// de aquí abajo EXTRAE, COMPARA y DETECTA duplicados/inconsistencias --
// nada de esto confirma un pago ni completa una operación por sí solo. La
// confirmación bancaria sigue siendo 100% manual (ver /admin/confirmar-
// operacion/:id en index.js).
//
// ESTRATEGIA DE DEDUPLICACIÓN (ver migrations/0012_comprobante_identidad.sql):
//   A) EndToEndId (E2E) del PIX -- identificador fuerte, único en todo el
//      sistema PIX brasileño. Si se leyó con confianza, es la clave.
//   B) ID de transacción bancario -- identificador secundario, NO
//      garantizado único entre bancos distintos (se busca, pero no lleva
//      constraint UNIQUE).
//   C) Si ninguno existe: se sigue usando el fallback existente en
//      pix-flow.js (monto + ventana de tiempo), SIN CAMBIOS -- ver el
//      hallazgo documentado en la fase anterior. Monto+teléfono NUNCA se
//      vuelven una clave de unicidad permanente por sí solos: dos PIX
//      legítimos pueden compartir monto y hasta ocurrir el mismo día.
// ─────────────────────────────────────────

const pool = require("../../db");

// ─────────────────────────────────────────
// NORMALIZACIÓN
// ─────────────────────────────────────────

// Formato real de un E2E PIX: "E" + 8 dígitos (ISPB) + 10 dígitos
// (fecha/hora) + 11 caracteres alfanuméricos = 32 caracteres después de la
// "E" (33 en total). Se acepta un rango algo más laxo (28-34) para tolerar
// un carácter de más/menos que a veces mete el OCR, pero NUNCA se inventa
// ni se completa un E2E parcial -- si no cumple ni ese mínimo, se descarta.
function normalizarE2E(raw) {
    if (!raw) return null;
    const limpio = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!/^E[A-Z0-9]{27,33}$/.test(limpio)) return null;
    return limpio;
}

// Los IDs de transacción bancarios no tienen un formato único estandarizado
// -- se acepta un rango razonable de longitud, se recorta espacios, y nunca
// se le cambian mayúsculas/minúsculas (podría ser case-sensitive según el
// banco). Si es demasiado corto para ser un identificador real (ej. "1",
// "PIX"), se descarta en vez de arriesgar falsos "duplicados".
function normalizarTransaccionId(raw) {
    if (!raw) return null;
    const limpio = String(raw).trim();
    if (limpio.length < 6 || limpio.length > 60) return null;
    return limpio;
}

// Tri-estado a partir del booleano que ya calcula el prompt de OCR
// (destino_correcto, comparado contra getPIXAliases()/getPIXHolder() --
// ver src/flows/shared.js y src/config/env.js, que es de donde sale de
// forma centralizada el nombre/alias esperado -- nunca hardcodeado aquí ni
// en ningún otro punto disperso del código).
function calcularDestinatarioMatch(datos) {
    if (datos?.destino_correcto === true) return "coincide";
    if (datos?.destino_correcto === false) return "diferente";
    return "desconocido"; // no se pudo determinar -- nunca se asume nada
}

// Identidad efectiva de ESTE comprobante: prioriza E2E, luego ID de
// transacción, y si ninguno es legible, señala "fallback" (el caller debe
// seguir usando la protección existente de monto+ventana, sin cambios).
// Nota: `e2e`/`transaccionId` en el resultado llevan AMBOS valores
// normalizados cuando están presentes (para persistirlos completos, ver
// sección 2 de la fase) -- `tipo`/`columna`/`valor` son solo la prioridad
// de DEDUPLICACIÓN (E2E gana si existe, aunque también haya un ID de
// transacción legible).
function extraerIdentidadComprobante(datos) {
    const e2e           = normalizarE2E(datos?.e2e);
    const transaccionId = normalizarTransaccionId(datos?.id_transaccion);

    if (e2e) return { tipo: "e2e", columna: "comprobante_e2e", valor: e2e, e2e, transaccionId };
    if (transaccionId) return { tipo: "transaccion_id", columna: "comprobante_transaccion_id", valor: transaccionId, e2e: null, transaccionId };
    return { tipo: "fallback", columna: null, valor: null, e2e: null, transaccionId: null };
}

// ─────────────────────────────────────────
// BÚSQUEDA DE DUPLICADO POR IDENTIDAD FUERTE
// ─────────────────────────────────────────

// Busca una operación EXISTENTE con el mismo E2E o ID de transacción.
// Excluye 'rechazada' -- mismo criterio que ya usaba el dedup por
// monto+ventana (una operación rechazada no cuenta como "ya procesada").
// Nunca se llama con identidad.tipo === "fallback" (el caller debe usar el
// chequeo de monto+ventana existente en ese caso).
async function buscarOperacionPorIdentidad(identidad) {
    if (!identidad || identidad.tipo === "fallback" || !identidad.columna) return null;
    try {
        const r = await pool.query(
            `SELECT * FROM operations WHERE ${identidad.columna} = $1 AND status != 'rechazada' ORDER BY id DESC LIMIT 1`,
            [identidad.valor]
        );
        return r.rows[0] || null;
    } catch (e) {
        // Columna todavía no migrada (0012 sin correr) u otro error de DB:
        // degrada a "no hay duplicado por identidad" -- el caller sigue con
        // el fallback de monto+ventana, nunca se cae el flujo por esto.
        console.warn("⚠️ buscarOperacionPorIdentidad no disponible:", e.message);
        return null;
    }
}

module.exports = {
    normalizarE2E,
    normalizarTransaccionId,
    calcularDestinatarioMatch,
    extraerIdentidadComprobante,
    buscarOperacionPorIdentidad
};
