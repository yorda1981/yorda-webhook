"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const service = require("../src/services/director/best-decision");

const root = path.join(__dirname, "..");

const facts = [
    { id: "F1", dato: "12 personas escribieron al bot." },
    { id: "F3", dato: "8 cotizaciones siguen sin cierre." }
];

function proposal(overrides = {}) {
    return {
        accion: "CREAR",
        decision: "Recuperar las cotizaciones abiertas",
        problema: "Hay intención de compra sin cierre.",
        evidenciaIds: ["F3", "INVENTADA"],
        causaProbable: "Los clientes no avanzaron al pago.",
        justificacion: "Es la oportunidad más cercana a una remesa.",
        accionRecomendada: "Revisar hoy las cotizaciones abiertas.",
        resultadoEsperado: "Aumentar los pagos confirmados.",
        impacto: 70,
        confianza: 80,
        ventajaCambio: 0,
        motivoCambio: null,
        explicacionCambio: "",
        ...overrides
    };
}

test("solo acepta evidencia que existe en el resumen comercial", () => {
    const normalized = service.normalizeProposal(proposal(), facts);
    assert.deepEqual(normalized.evidence, [facts[1]]);
    assert.equal(normalized.impacto, 70);
});

test("una alternativa ligeramente mejor no sustituye la decisión vigente", () => {
    const current = { impacto: 70 };
    const candidate = service.normalizeProposal(proposal({
        accion: "REEMPLAZAR", impacto: 75, ventajaCambio: 12,
        motivoCambio: "OPORTUNIDAD_SUPERIOR", explicacionCambio: "Apareció otra oportunidad."
    }), facts);
    assert.equal(service.replacementAllowed(current, candidate), false);
});

test("una oportunidad claramente superior puede sustituir la decisión vigente", () => {
    const current = { impacto: 65 };
    const candidate = service.normalizeProposal(proposal({
        accion: "REEMPLAZAR", impacto: 82, ventajaCambio: 30,
        motivoCambio: "OPORTUNIDAD_SUPERIOR", explicacionCambio: "La nueva fuga afecta a más clientes y es urgente."
    }), facts);
    assert.equal(service.replacementAllowed(current, candidate), true);
});

test("cambio material o evidencia inválida permiten reaccionar sin comparar puntuaciones", () => {
    const current = { impacto: 90 };
    for (const reason of ["CAMBIO_MATERIAL", "EVIDENCIA_INVALIDA", "NO_EJECUTABLE"]) {
        const candidate = service.normalizeProposal(proposal({
            accion: "REEMPLAZAR", impacto: 60, ventajaCambio: 0,
            motivoCambio: reason, explicacionCambio: "La situación anterior dejó de representar la realidad."
        }), facts);
        assert.equal(service.replacementAllowed(current, candidate), true);
    }
});

test("la estabilidad mantiene la prioridad y solo actualiza su última evaluación", async () => {
    const calls = [];
    const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
    const current = { id: 7, impacto: 70, decision: "Prioridad vigente" };
    const candidate = service.normalizeProposal(proposal({
        accion: "REEMPLAZAR", impacto: 76, ventajaCambio: 10,
        motivoCambio: "OPORTUNIDAD_SUPERIOR", explicacionCambio: "Mejora pequeña."
    }), facts);
    const result = await service.applyProposal(db, current, candidate, {});
    assert.equal(result.changed, false);
    assert.equal(result.decision.id, 7);
    assert.equal(result.reason, "ESTABILIDAD");
    assert.match(calls[0].sql, /evaluada_at = NOW/);
});

test("la sustitución cierra la anterior y crea exactamente una nueva prioridad en transacción", async () => {
    const calls = [];
    const client = { query: async (sql) => {
        calls.push(String(sql).replace(/\s+/g, " ").trim());
        if (String(sql).includes("INSERT INTO director_decisions")) return { rows: [{
            id: 8, estado: "VIGENTE", decision: "Nueva prioridad", problema: "P", evidencia: facts,
            justificacion: "J", accion_recomendada: "A", resultado_esperado: "R",
            impacto: 85, confianza: 80, sustituye_id: 7
        }] };
        return { rows: [] };
    }, release() { calls.push("RELEASE"); } };
    const db = { connect: async () => client };
    const current = { id: 7, impacto: 65 };
    const candidate = service.normalizeProposal(proposal({
        accion: "REEMPLAZAR", impacto: 85, ventajaCambio: 30,
        motivoCambio: "OPORTUNIDAD_SUPERIOR", explicacionCambio: "La ventaja compensa interrumpir."
    }), facts);
    const result = await service.applyProposal(db, current, candidate, { dato: true });
    assert.equal(result.changed, true);
    assert.equal(result.decision.id, 8);
    assert.deepEqual(calls.slice(0, 4), ["BEGIN", calls[1], calls[2], "COMMIT"]);
    assert.match(calls[1], /estado = 'SUSTITUIDA'/);
    assert.match(calls[2], /INSERT INTO director_decisions/);
    assert.equal(calls.at(-1), "RELEASE");
});

test("la instantánea convierte únicamente datos existentes en hechos citables", async () => {
    const db = { query: async () => ({ rows: [{
        conversaciones_24h: "10", conversaciones_media_7d: "7.285",
        cotizaciones_24h: "4", cotizaciones_media_7d: "3",
        cotizaciones_sin_cierre_48h: "6", abandonos_7d: "2",
        operaciones_24h: "3", operaciones_media_7d: "2.2",
        remesas_24h: "2", remesas_media_7d: "1.5", operaciones_pendientes_48h: "1",
        miembros_grupo: "120", altas_grupo_24h: "3", bajas_grupo_24h: "1",
        publicaciones_7d: "2", tasas_actualizadas_at: new Date("2026-10-13T10:00:00Z"),
        capturado_at: new Date("2026-10-13T12:00:00Z")
    }] }) };
    const snapshot = await service.collectCommercialSnapshot(db);
    assert.equal(snapshot.conversaciones24h, 10);
    assert.equal(snapshot.conversacionesMedia7d, 7.3);
    assert.match(service.snapshotFacts(snapshot)[2].dato, /6 cotizaciones/);
});

test("migración, rutas, arranque e interfaz exponen una única decisión vigente", () => {
    const migration = fs.readFileSync(path.join(root, "migrations/0031_best_available_decision.sql"), "utf8");
    const routes = fs.readFileSync(path.join(root, "src/routes/content-library.js"), "utf8");
    const index = fs.readFileSync(path.join(root, "index.js"), "utf8");
    const ui = fs.readFileSync(path.join(root, "public/content-center.html"), "utf8");
    assert.match(migration, /WHERE estado = 'VIGENTE'/);
    assert.match(routes, /router\.get\("\/director\/decision"/);
    assert.match(routes, /router\.post\("\/director\/decision\/refresh"/);
    assert.match(index, /bestDecision\.startBestDecision\(\)/);
    assert.match(ui, /Mejor Decisión Disponible/);
    assert.match(ui, /Por qué cambió la prioridad/);
});
