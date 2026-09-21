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
//      garantizado único entre bancos distintos. Por eso NUNCA se usa
//      solo: se combina con el banco normalizado ("BANCO::ID") antes de
//      compararlo -- dos bancos distintos con el mismo ID de transacción
//      generan identidades DIFERENTES (ver auditoría de 7728e66, hallazgo
//      I1). Si el banco no se pudo leer, el ID por sí solo NO se
//      considera una identidad fuerte -- cae al fallback (C).
//   C) Si ninguno existe (o el ID de transacción no vino acompañado de un
//      banco legible): se sigue usando el fallback existente en
//      pix-flow.js (monto + ventana de tiempo), SIN CAMBIOS -- ver el
//      hallazgo documentado en la fase anterior. Monto+teléfono NUNCA se
//      vuelven una clave de unicidad permanente por sí solos: dos PIX
//      legítimos pueden compartir monto y hasta ocurrir el mismo día.
// ─────────────────────────────────────────

const pool = require("../../db");

// ─────────────────────────────────────────
// NORMALIZACIÓN
// ─────────────────────────────────────────

// Formato real de un EndToEndId PIX (Banco Central do Brasil / SPI): "E" +
// ISPB (8 dígitos) + fecha AAAAMMDD (8) + hora HHmm (4) + sufijo
// alfanumérico (11) = 31 caracteres DESPUÉS de la "E", 32 en total.
// (Corregido tras la auditoría de 7728e66, hallazgo I6 -- el comentario
// anterior decía 32/33 por error de conteo; verificado contra la
// documentación oficial del BCB.) Se acepta ±3 caracteres alrededor del
// valor real (31 después de la E, es decir 28-34) para tolerar un
// carácter de más/menos que a veces mete el OCR, sin ser tan rígido que
// rechace un E2E real por un carácter mal leído -- pero NUNCA se inventa
// ni se completa un E2E parcial: si no cumple ni ese mínimo, se descarta.
function normalizarE2E(raw) {
    if (!raw) return null;
    const limpio = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!/^E[A-Z0-9]{28,34}$/.test(limpio)) return null;
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

// El nombre del banco SÍ se normaliza de forma más agresiva (mayúsculas,
// sin acentos, recortado) porque aquí solo se usa para DISTINGUIR bancos
// entre sí como parte de la identidad compuesta con el ID de transacción
// -- no hace falta preservar el texto exacto (eso ya vive aparte en
// comprobante_datos.bancoOrigen, sin normalizar, para mostrarlo tal cual).
function normalizarBanco(raw) {
    if (!raw) return null;
    const limpio = String(raw).trim().toUpperCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "");
    return limpio.length >= 2 ? limpio : null;
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

// Separador interno para la identidad compuesta banco+transacción. No es
// un carácter que normalizarBanco()/normalizarTransaccionId() puedan
// producir por sí solos (ambos son alfanuméricos tras normalizar), así
// que no hay riesgo real de que dos pares (banco,id) distintos colisionen
// en el mismo string compuesto.
const SEPARADOR_IDENTIDAD_COMPUESTA = "::";

// Identidad efectiva de ESTE comprobante: prioriza E2E; si no hay E2E pero
// SÍ hay un ID de transacción CON banco legible, usa la identidad
// COMPUESTA banco+id (hallazgo I1 de la auditoría de 7728e66 -- un ID de
// transacción solo nunca es una identidad fuerte, porque bancos distintos
// pueden repetirlo). Si no hay banco legible, el ID de transacción se
// descarta como identidad fuerte -- comportamiento conservador, cae a
// "fallback" (monto+ventana) en vez de inventar una identidad global a
// partir de un dato potencialmente genérico.
//
// Nota: `e2e`/`transaccionId`/`banco` en el resultado llevan los valores
// normalizados por separado cuando están presentes (para persistirlos
// para auditoría, ver sección 2 de la fase) -- `tipo`/`columna`/`valor`
// son la identidad efectiva usada para DEDUPLICAR.
function extraerIdentidadComprobante(datos) {
    const e2e           = normalizarE2E(datos?.e2e);
    const transaccionId = normalizarTransaccionId(datos?.id_transaccion);
    const banco         = normalizarBanco(datos?.banco);

    if (e2e) {
        return { tipo: "e2e", columna: "comprobante_e2e", valor: e2e, e2e, transaccionId, banco };
    }
    if (transaccionId && banco) {
        const compuesto = `${banco}${SEPARADOR_IDENTIDAD_COMPUESTA}${transaccionId}`;
        return { tipo: "transaccion_id", columna: "comprobante_transaccion_id", valor: compuesto, e2e: null, transaccionId, banco };
    }
    return { tipo: "fallback", columna: null, valor: null, e2e: null, transaccionId, banco };
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
    normalizarBanco,
    calcularDestinatarioMatch,
    extraerIdentidadComprobante,
    buscarOperacionPorIdentidad
};
