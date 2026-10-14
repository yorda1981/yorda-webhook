"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const promotion = require("../src/services/director/promotion-calculator");
const decision = require("../src/services/director/best-decision");
const { buildInitiativeContent } = require("../src/services/director/recovery-execution-package");

const NOW = new Date("2026-10-14T12:00:00.000Z");
const RATES = {
    id: 1, brl_0: 170, brl_100: 180, brl_500: 185, brl_1000: 190,
    updated_at: new Date("2026-10-14T11:00:00.000Z")
};

test("simula descuento sobre BRL y mejora porcentual de tasa usando CUP del cotizador", () => {
    const context = promotion.buildScenarios(RATES, RATES.updated_at, NOW);
    assert.equal(context.disponible, true);
    const hundred = context.escenarios.find(item => item.importeTransferenciaBRL === 100);
    assert.equal(hundred.normal.tasa, 180);
    assert.equal(hundred.normal.recibeCUP, 18000);

    const discount = hundred.descuentos.find(item => item.porcentaje === 1);
    assert.equal(discount.pagaClienteBRL, 99);
    assert.equal(discount.recibePromocionCUP, 18000);
    assert.equal(discount.costoBeneficioBRL, 1);
    assert.equal(discount.margenReferenciaRestanteBRL, 4);

    const rate = hundred.mejorasTasa.find(item => item.porcentaje === 1);
    assert.equal(rate.tasaPromocional, 181.8);
    assert.equal(rate.recibePromocionCUP, 18180);
    assert.equal(rate.costoBeneficioBRL, 1);
    assert.equal(rate.margenReferenciaRestantePct, 4);
    assert.equal(rate.rentabilidadVerificada, false);
    assert.match(context.notaRentabilidad, /no autoriza/);
});
test("una tasa de varios días sigue vigente si sus valores son válidos; una incompleta queda pendiente", () => {
    const old = promotion.buildScenarios(RATES, new Date("2026-10-13T23:00:00.000Z"), NOW);
    assert.equal(old.disponible, true);
    assert.equal(old.updatedAt, "2026-10-13T23:00:00.000Z");
    const incomplete = promotion.buildScenarios({ ...RATES, brl_500: null }, RATES.updated_at, NOW);
    assert.equal(incomplete.disponible, false);
    assert.match(incomplete.motivo, /Falta una tasa/);
});

test("normaliza una oferta económica con simulación pero nunca la marca rentable o ejecutable", () => {
    const facts = [{ id: "F1", dato: "Cotizaciones abiertas" }];
    const context = promotion.buildScenarios(RATES, RATES.updated_at, NOW);
    const offer = decision.normalizeProposal({ alternativas: [{
        id: "S1", nombre: "Mejora para primera remesa", mecanismo: "Oferta de conversión",
        evidenciaIds: ["F1"], oferta: { tipo: "MEJORA_TASA", porcentaje: 1 },
        accionRecomendada: "Evaluar una mejora de tasa", pasos: ["Validar costos"], ejecutable: true,
        costo: { tipo: "ECONOMICO", estimacion: 0, baseVerificada: true }
    }] }, facts, context).alternatives[0];
    assert.equal(offer.oferta.tipo, "MEJORA_TASA");
    assert.equal(offer.simulacionPromocion.length, 12);
    assert.equal(offer.costo.baseVerificada, false);
    assert.equal(offer.ejecutable, false);
    assert.equal(offer.requiereCompromisoEconomico, true);
});

test("paquete comercial muestra simulación actual y mantiene bloqueada una oferta económica", () => {
    const context = promotion.buildScenarios(RATES, RATES.updated_at, NOW);
    const packageContent = buildInitiativeContent({
        id: 9, estado: "VIGENTE", decision: "Oferta para recuperar cotizaciones", problema: "P",
        evidencia: [{ id: "F1", dato: "Hecho" }], accionRecomendada: "Probar oferta",
        resultadoEsperado: "Más cotizaciones", alternativas: [],
        estrategiaElegida: {
            id: "S1", nombre: "Mejorar tasa", oferta: { tipo: "MEJORA_TASA", porcentaje: 2 },
            requiereCompromisoEconomico: true, materiales: [], capacidadesFaltantes: [], evidencia: [{ id: "F1" }]
        }
    }, NOW, context);
    assert.equal(packageContent.simulacionPromocion.disponible, true);
    assert.equal(packageContent.estrategiaElegida.simulacionPromocion.length, 12);
    assert.equal(packageContent.ejecucion.listaParaAprobar, false);
    assert.ok(packageContent.capacidadesFaltantes.some(item => /costos reales/.test(item)));
});

test("si cambia la tasa, aprobación recalcula el paquete y exige una nueva revisión", async () => {
    const priorRates = { ...RATES, brl_100: 179 };
    const priorRevision = promotion.buildScenarios(priorRates, RATES.updated_at, NOW).revision;
    const row = { id: 5, decision_id: 8, tipo: "INICIATIVA_COMERCIAL", estado: "BORRADOR", contenido: {
        estrategiaElegida: { oferta: { tipo: "MEJORA_TASA", porcentaje: 1 } },
        alternativas: [{ id: "S1", oferta: { tipo: "MEJORA_TASA", porcentaje: 1 } }],
        simulacionPromocion: { updatedAt: "2026-10-13T10:00:00.000Z", revision: priorRevision },
        ejecucion: { listaParaAprobar: false }, materiales: []
    } };
    const calls = [];
    const db = { query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes("SELECT * FROM director_execution_packages")) return { rows: [row] };
        if (sql.includes("SELECT * FROM rates")) return { rows: [RATES] };
        if (sql.includes("SELECT activa, vence_at")) return { rows: [] };
        if (sql.includes("UPDATE director_execution_packages")) return { rows: [{ ...row, contenido: JSON.parse(params[1]) }] };
        throw new Error("consulta no esperada");
    } };
    const packages = require("../src/services/director/recovery-execution-package");
    await assert.rejects(() => packages.resolvePackage(5, "approve", db, { now: NOW }), /tasa vigente cambió/);
    assert.equal(calls.some(call => /estado = 'APROBADO'/.test(call.sql)), false);
    assert.equal(calls.some(call => /INSERT INTO content|INSERT INTO director_drafts/i.test(call.sql)), false);
    const update = calls.find(call => call.sql.includes("UPDATE director_execution_packages"));
    const refreshed = JSON.parse(update.params[1]).simulacionPromocion;
    assert.equal(refreshed.updatedAt, RATES.updated_at.toISOString());
    assert.equal(refreshed.revision, promotion.buildScenarios(RATES, RATES.updated_at, NOW).revision);
});

test("una iniciativa económica no puede aprobarse aunque haya borradores de Biblioteca", async () => {
    const row = { id: 6, decision_id: 9, tipo: "INICIATIVA_COMERCIAL", estado: "BORRADOR", contenido: {
        estrategiaElegida: { oferta: { tipo: "DESCUENTO_TRANSFERENCIA", porcentaje: 1 }, requiereCompromisoEconomico: true },
        simulacionPromocion: promotion.buildScenarios(RATES, RATES.updated_at, NOW), costos: { baseVerificada: false },
        ejecucion: { listaParaAprobar: false }, materiales: [{ tipo: "biblioteca", titulo: "Oferta", contenido: "Prueba" }]
    } };
    const db = { query: async sql => {
        if (sql.includes("SELECT * FROM director_execution_packages")) return { rows: [row] };
        if (sql.includes("SELECT * FROM rates")) return { rows: [RATES] };
        if (sql.includes("SELECT activa, vence_at")) return { rows: [] };
        throw new Error("consulta no esperada");
    } };
    const packages = require("../src/services/director/recovery-execution-package");
    await assert.rejects(() => packages.resolvePackage(6, "approve", db, { now: NOW }), /No se puede aprobar una promoción económica/);
});

test("una tasa sin cambios y con fecha antigua permite enviar tras confirmar los valores vigentes", async () => {
    const oldDate = new Date("2026-10-01T08:00:00.000Z");
    const currentContext = promotion.buildScenarios(RATES, oldDate, NOW);
    const row = { id: 7, decision_id: 10, tipo: "RECUPERACION_ABANDONOS", estado: "BORRADOR", contenido: {
        simulacionPromocion: currentContext,
        clientes: [{ incluido: true, phone: "+5350000000", mensaje: "Hola, la tasa está vigente para tu envío.", familia: "recordatorio_normal" }],
        ejecucion: {}
    } };
    const calls = [];
    const db = { query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes("SELECT * FROM director_execution_packages")) return { rows: [row] };
        if (sql.includes("SELECT * FROM rates")) return { rows: [{ ...RATES, updated_at: oldDate }] };
        if (sql.includes("SELECT activa, vence_at")) return { rows: [] };
        if (sql.includes("UPDATE director_execution_packages")) return { rows: [{ ...row, estado: "APROBADO", contenido: JSON.parse(params[2] || params[1]) }] };
        throw new Error("consulta no esperada");
    } };
    let sends = 0;
    const packages = require("../src/services/director/recovery-execution-package");
    const result = await packages.resolvePackage(7, "approve", db, { now: NOW, sendRecovery: async () => { sends += 1; return { code: "ENVIADO" }; } });
    assert.equal(sends, 1);
    assert.equal(result.estado, "APROBADO");
    assert.equal(result.contenido.simulacionPromocion.updatedAt, oldDate.toISOString());
    assert.equal(calls.filter(call => call.sql.includes("SELECT * FROM rates")).length, 2);
});

test("mensajes sin tasas ni beneficios no se bloquean si rates no se puede consultar", async () => {
    const row = { id: 9, decision_id: 12, tipo: "RECUPERACION_ABANDONOS", estado: "BORRADOR", contenido: {
        clientes: [{ incluido: true, phone: "+5350000001", mensaje: "Hola, ¿cómo estás?", familia: "recordatorio_normal" }],
        ejecucion: {}
    } };
    let sends = 0;
    const db = { query: async (sql, params) => {
        if (sql.includes("SELECT * FROM director_execution_packages")) return { rows: [row] };
        if (sql.includes("UPDATE director_execution_packages")) return { rows: [{ ...row, estado: "APROBADO", contenido: JSON.parse(params[2]) }] };
        if (sql.includes("rates")) throw new Error("un mensaje independiente de tasas no debe consultar rates");
        throw new Error("consulta no esperada");
    } };
    const packages = require("../src/services/director/recovery-execution-package");
    const result = await packages.resolvePackage(9, "approve", db, { now: NOW,
        sendRecovery: async () => { sends += 1; return { code: "ENVIADO" }; } });
    assert.equal(sends, 1);
    assert.equal(result.estado, "APROBADO");
});

test("si la tasa cambia durante una campaña, detiene los siguientes mensajes y guarda el recálculo", async () => {
    const row = { id: 8, decision_id: 11, tipo: "RECUPERACION_ABANDONOS", estado: "BORRADOR", contenido: {
        simulacionPromocion: promotion.buildScenarios(RATES, RATES.updated_at, NOW),
        clientes: ["+5350000001", "+5350000002"].map(phone => ({ incluido: true, phone, mensaje: "La tasa actual te puede interesar." })),
        ejecucion: {}
    } };
    const changedRates = { ...RATES, brl_100: RATES.brl_100 + 1 };
    let ratesReads = 0;
    let sends = 0;
    let savedContent;
    const db = { query: async (sql, params) => {
        if (sql.includes("SELECT * FROM director_execution_packages")) return { rows: [row] };
        if (sql.includes("SELECT * FROM rates")) return { rows: [++ratesReads <= 2 ? RATES : changedRates] };
        if (sql.includes("SELECT activa, vence_at")) return { rows: [] };
        if (sql.includes("UPDATE director_execution_packages")) {
            savedContent = JSON.parse(params[1]);
            return { rows: [{ ...row, contenido: savedContent }] };
        }
        throw new Error("consulta no esperada");
    } };
    const packages = require("../src/services/director/recovery-execution-package");
    await assert.rejects(() => packages.resolvePackage(8, "approve", db, {
        now: NOW, sendRecovery: async () => { sends += 1; return { code: "ENVIADO" }; }
    }), /La tasa cambió durante el envío/);
    assert.equal(sends, 1);
    assert.equal(savedContent.simulacionPromocion.revision,
        promotion.buildScenarios(changedRates, changedRates.updated_at, NOW).revision);
    assert.equal(savedContent.ejecucion.resultadosParciales.length, 1);
    assert.match(savedContent.clientes[1].mensaje, /valores vigentes/);
    assert.doesNotMatch(savedContent.clientes[1].mensaje, /La tasa actual/);
});
