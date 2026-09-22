"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — CRM de Recuperación, FASE 1 (solo lectura)
// (src/services/recuperacion.js + GET /admin/recuperacion/candidatos)
//
// Dos capas, mismo criterio que test/resumen-general-metricas.test.js:
//   1) Estructura de la consulta SQL real (vía mock de pool.query que
//      captura el texto) -- prueba que cada exclusión/inclusión pedida
//      existe en el WHERE, sin reimplementar la lógica en paralelo.
//   2) Funciones puras (etiquetaServicio/prioridadDeEstado/antiguedadDe) y
//      el mapeo de fila->candidato, con filas fijas.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pool = require("../db");
const recuperacion = require("../src/services/recuperacion");
const {
    obtenerCandidatosRecuperacion, etiquetaServicio, prioridadDeEstado, antiguedadDe
} = recuperacion;

async function capturarSQL(t, rows = []) {
    let sql = "";
    t.mock.method(pool, "query", async (consulta) => { sql = consulta; return { rows }; });
    await obtenerCandidatosRecuperacion();
    return sql;
}

// ── 1-2. Prioridad por estado (aguardando_comprovante->Alta, cotizacion_realizada->Media) ──

test("prioridadDeEstado: aguardando_comprovante -> alta", () => {
    assert.equal(prioridadDeEstado("aguardando_comprovante"), "alta");
});

test("prioridadDeEstado: cotizacion_realizada -> media", () => {
    assert.equal(prioridadDeEstado("cotizacion_realizada"), "media");
});

test("prioridadDeEstado: cualquier otro estado -> null (nunca genera un candidato)", () => {
    assert.equal(prioridadDeEstado("aguardando_numero_recarga"), null);
    assert.equal(prioridadDeEstado(null), null);
});

test("la consulta incluye EXACTAMENTE los dos estados esperados en el filtro de inclusión", async (t) => {
    const sql = await capturarSQL(t);
    assert.match(sql, /estado IN \('aguardando_comprovante', 'cotizacion_realizada'\)/);
});

// ── 3-4. Operación confirmada/completada posterior -> excluido ──

test("la consulta excluye por NOT EXISTS cuando ya hay operación 'confirmada' o 'completada'", async (t) => {
    const sql = await capturarSQL(t);
    assert.match(sql, /NOT EXISTS[\s\S]*?FROM operations o[\s\S]*?status IN \('confirmada','completada'\)/);
});

// ── 5. Operación ANTERIOR al intento no debe excluir (comparación forward-only) ──

test("la exclusión por operación real compara created_at > fecha del intento (nunca <, nunca sin fecha) -- una operación anterior no excluye", async (t) => {
    const sql = await capturarSQL(t);
    assert.match(sql, /o\.created_at\s*>\s*COALESCE\(cu\.fecha_estado,\s*cu\.fecha_cotizacion\)/);
    // Nunca debe compararse hacia atrás (<) en esta subconsulta -- eso
    // excluiría por una operación vieja ya cerrada, que no invalida el
    // intento actual.
    const bloqueOperations = sql.match(/NOT EXISTS[\s\S]*?FROM operations o[\s\S]*?\)\s*\)/)[0];
    assert.doesNotMatch(bloqueOperations, /created_at\s*</);
});

// ── 6. Bloqueado -> excluido ──

test("la consulta excluye bloqueados vía NOT EXISTS sobre blocked_numbers", async (t) => {
    const sql = await capturarSQL(t);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM blocked_numbers b WHERE b\.phone = cu\.phone\)/);
});

// ── 7-8. Pausa humana activa -> excluido / vencida -> permitido ──

test("la consulta excluye pausa humana activa y permite pausa vencida o inexistente (mismo campo que enPausaHumana)", async (t) => {
    const sql = await capturarSQL(t);
    assert.match(sql, /cu\.pausa_hasta IS NULL OR cu\.pausa_hasta < NOW\(\)/);
});

// ── 9. Antigüedad mínima de 2 horas ──

test("la consulta exige al menos 2 horas de antigüedad del intento (mismo umbral que el flujo de PIX)", async (t) => {
    const sql = await capturarSQL(t);
    assert.match(sql, /COALESCE\(cu\.fecha_estado, cu\.fecha_cotizacion\) < NOW\(\) - INTERVAL '2 hours'/);
});

// ── 10. Clasificación visual por antigüedad ──

test("antiguedadDe: menos de 24h -> reciente", () => {
    const hace1h = new Date(Date.now() - 60 * 60000);
    assert.equal(antiguedadDe(hace1h), "reciente");
});

test("antiguedadDe: entre 1 y 7 días -> '1-7 dias'", () => {
    const hace3dias = new Date(Date.now() - 3 * 24 * 60 * 60000);
    assert.equal(antiguedadDe(hace3dias), "1-7 dias");
});

test("antiguedadDe: más de 7 días -> 'recuperacion'", () => {
    const hace10dias = new Date(Date.now() - 10 * 24 * 60 * 60000);
    assert.equal(antiguedadDe(hace10dias), "recuperacion");
});

test("antiguedadDe: sin fecha -> null (nunca inventa una antigüedad)", () => {
    assert.equal(antiguedadDe(null), null);
});

// ── 11-12. estado_crm NUNCA es criterio de inclusión ni duplica candidatos ──

test("estado_crm NO aparece como condición de inclusión en el WHERE -- 'abandono' por sí solo no genera candidatos", async (t) => {
    const sql = await capturarSQL(t);
    const desdeWhere = sql.slice(sql.indexOf("WHERE"));
    assert.doesNotMatch(desdeWhere, /estado_crm\s*(=|IN)/, "estado_crm solo debe aparecer en el SELECT (informativo), nunca en el WHERE");
    // Sí debe seguir devolviéndose como dato informativo en el SELECT.
    assert.match(sql.slice(0, sql.indexOf("WHERE")), /cu\.estado_crm/);
});

test("la consulta es un único SELECT sin UNION ni JOIN que multiplique filas -- un candidato nunca puede duplicarse por estado_crm", async (t) => {
    const sql = await capturarSQL(t);
    assert.doesNotMatch(sql, /UNION/i);
    assert.doesNotMatch(sql, /JOIN operations/i);
    assert.doesNotMatch(sql, /JOIN blocked_numbers/i);
});

// ── Servicio de interés (mapeo directo, sin inferencia) ──

test("etiquetaServicio: mapeo exacto de cada tipo_favorito pedido", () => {
    assert.equal(etiquetaServicio("brl_cup"), "CUP transferencia");
    assert.equal(etiquetaServicio("usd_clasica"), "USD Clásica");
    assert.equal(etiquetaServicio("usd_prepago"), "USD Prepago/Internacional");
    assert.equal(etiquetaServicio("usd_pendiente_tipo"), "USD — tipo pendiente");
    assert.equal(etiquetaServicio("mlc"), "MLC");
    assert.equal(etiquetaServicio("cup_efectivo"), "CUP efectivo");
    assert.equal(etiquetaServicio("usd_efectivo"), "USD efectivo");
    assert.equal(etiquetaServicio("recarga_nacional"), "Recarga nacional");
    assert.equal(etiquetaServicio("recarga_internacional"), "Recarga internacional");
});

test("etiquetaServicio: tipo desconocido -> se devuelve tal cual (nunca inventa una etiqueta); sin tipo -> 'Sin definir'", () => {
    assert.equal(etiquetaServicio("algo_nuevo"), "algo_nuevo");
    assert.equal(etiquetaServicio(null), "Sin definir");
});

// ── Mapeo fila -> candidato (con filas fijas, sin depender del mock de exclusión) ──

test("obtenerCandidatosRecuperacion: mapea cada fila con prioridad/servicio/antigüedad correctos", async (t) => {
    const hace10dias = new Date(Date.now() - 10 * 24 * 60 * 60000).toISOString();
    t.mock.method(pool, "query", async () => ({
        rows: [{
            phone: "5511900020001", nombre: "Ana", estado: "aguardando_comprovante",
            tipo_favorito: "usd_clasica", ultimo_monto: "500", fecha_intento: hace10dias,
            estado_crm: "abandono", ultimo_recordatorio: hace10dias, tipo_ultimo_recordatorio: "recuperar_24h"
        }]
    }));
    const [c] = await obtenerCandidatosRecuperacion();
    assert.equal(c.prioridad, "alta");
    assert.equal(c.servicio, "USD Clásica");
    assert.equal(c.antiguedad, "recuperacion");
    assert.equal(c.ultimoMonto, 500);
    assert.equal(typeof c.ultimoMonto, "number");
    assert.equal(c.estadoCrm, "abandono"); // informativo, no decide inclusión
});

test("obtenerCandidatosRecuperacion: error de DB -> lista vacía, nunca revienta", async (t) => {
    t.mock.method(pool, "query", async () => { throw new Error("boom"); });
    const r = await obtenerCandidatosRecuperacion();
    assert.deepEqual(r, []);
});

// ── 14. El endpoint nunca escribe -- el servicio entero es de solo lectura ──

test("obtenerCandidatosRecuperacion: el código fuente no contiene ninguna escritura (INSERT/UPDATE/DELETE)", () => {
    const codigo = fs.readFileSync(path.join(__dirname, "..", "src", "services", "recuperacion.js"), "utf8");
    assert.doesNotMatch(codigo, /\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
});

// ── 13. El endpoint exige autenticación admin (misma protección que el resto de /admin) ──

test("GET /admin/recuperacion/candidatos está registrado con adminReadLimiter + verificarToken (401 sin auth, igual que el resto de /admin)", () => {
    const codigo = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    assert.match(codigo, /app\.get\("\/admin\/recuperacion\/candidatos",\s*adminReadLimiter,\s*verificarToken/);
});
