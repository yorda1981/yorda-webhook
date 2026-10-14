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
    const value = {
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
    value.alternativas ||= [
        { id:"S1", nombre:value.decision, mecanismo:"Seguimiento de cotizaciones", problema:value.problema,
            evidenciaIds:["F3"], causaProbable:value.causaProbable, justificacion:value.justificacion,
            accionRecomendada:value.accionRecomendada, resultadoEsperado:value.resultadoEsperado,
            impacto:value.impacto, viabilidad:80, riesgo:10, confianza:value.confianza,
            costo:{ tipo:"SIN_COSTO", explicacion:"Sin gasto nuevo" }, ejecutable:true, pasos:["Revisar cotizaciones"] },
        { id:"S2", nombre:"Mejorar atención", mecanismo:"Optimización del flujo del bot", problema:"Dudas repetidas",
            evidenciaIds:["F1"], justificacion:"Resolver fricción", accionRecomendada:"Revisar dudas",
            resultadoEsperado:"Más cotizaciones", impacto:55, viabilidad:70, riesgo:15, confianza:60,
            costo:{ tipo:"DESCONOCIDO", explicacion:"Costo operativo no medido" }, ejecutable:true, pasos:["Revisar conversaciones"] },
        { id:"S3", nombre:"Activar referidos", mecanismo:"Adquisición por recomendación", problema:"Captación",
            evidenciaIds:["F1"], justificacion:"Explorar referidos", accionRecomendada:"Diseñar piloto de recomendación boca a boca sin pago",
            resultadoEsperado:"Nuevos clientes", impacto:60, viabilidad:60, riesgo:20, confianza:55,
            costo:{ tipo:"DESCONOCIDO", explicacion:"No hay costos de incentivos disponibles" }, ejecutable:true, pasos:["Validar propuesta"] }
    ];
    value.estrategiaElegidaId ||= "S1";
    return value;
}

test("solo acepta evidencia que existe en el resumen comercial", () => {
    const normalized = service.normalizeProposal(proposal(), facts);
    assert.deepEqual(normalized.evidence, [facts[1]]);
    assert.equal(normalized.impacto, 70);
});

test("la prioridad exige tres mecanismos comerciales distintos y no inventa costos", () => {
    const normalized = service.normalizeProposal(proposal({ alternativas: proposal().alternativas }), facts);
    assert.equal(normalized.alternativesValid, true);
    assert.equal(normalized.alternatives.length, 3);
    assert.equal(normalized.alternatives[2].costo.estimacion, null);
    assert.equal(normalized.alternatives[2].ejecutable, true);
    const repetitive = service.normalizeProposal(proposal({ alternativas: proposal().alternativas.map(item => ({ ...item, mecanismo:"Mensaje promocional" })) }), facts);
    assert.equal(repetitive.alternativesValid, false);
});

test("rechaza costos afirmados por el modelo y no elige ofertas sin rentabilidad verificada", () => {
    const alternatives = proposal().alternativas.map(item => ({ ...item }));
    alternatives[0] = { ...alternatives[0], accionRecomendada: "Ofrecer un descuento de R$ 20", costo: {
        tipo: "SIN_COSTO", estimacion: 0, baseVerificada: true, explicacion: "modelo dice verificado"
    } };
    const normalized = service.normalizeProposal(proposal({ alternativas: alternatives, estrategiaElegidaId: "S1" }), facts);
    assert.equal(normalized.alternatives[0].costo.baseVerificada, false);
    assert.equal(normalized.alternatives[0].costo.estimacion, null);
    assert.equal(normalized.alternatives[0].ejecutable, false);
    assert.equal(normalized.selectedStrategy.id, "S2");
});

test("no presenta elegibilidad, pronósticos de conversiones ni ganancia como cifras verificadas", () => {
    const alternatives = proposal().alternativas.map(item => ({ ...item }));
    alternatives[0].resultadoEsperado = "12 remesas nuevas y R$ 500 de ganancia";
    alternatives[0].destinatarios = { criterio: "78 clientes listos", basadoEnDatos: true };
    const normalized = service.normalizeProposal(proposal({ alternativas: alternatives }), facts);
    assert.match(normalized.alternatives[0].resultadoEsperado, /no cuantificable/);
    assert.equal(normalized.alternatives[0].gananciaIncremental.estimacionBRL, null);
    assert.equal(normalized.alternatives[0].destinatarios.basadoEnDatos, false);
    assert.match(normalized.alternatives[0].destinatarios.criterio, /no se verificaron/);
});

test("una recompensa de referidos siempre queda como compromiso económico pendiente", () => {
    const alternatives = proposal().alternativas.map(item => ({ ...item }));
    alternatives[0] = { ...alternatives[0], nombre: "Programa de referidos", mecanismo: "Recomendación boca a boca",
        accionRecomendada: "Dar una recompensa del 1 % tras la primera transferencia confirmada", ejecutable: true };
    const normalized = service.normalizeProposal(proposal({ alternativas: alternatives, estrategiaElegidaId: "S1" }), facts);
    assert.equal(normalized.alternatives[0].requiereCompromisoEconomico, true);
    assert.equal(normalized.alternatives[0].ejecutable, false);
});

test("una oferta con porcentaje incompleto queda pendiente sin romper la evaluación", () => {
    const alternatives = proposal().alternativas.map(item => ({ ...item }));
    alternatives[0] = { ...alternatives[0], oferta: { tipo: "DESCUENTO_TRANSFERENCIA", porcentaje: 0 },
        accionRecomendada: "Evaluar una promoción económica pendiente" };
    const normalized = service.normalizeProposal(proposal({ alternativas: alternatives }), facts, null);
    assert.equal(normalized.alternatives[0].ejecutable, false);
    assert.deepEqual(normalized.alternatives[0].simulacionPromocion, []);
});

test("la evaluación real no es comparable hasta que el Director analice F19 como referidos al 1 %", () => {
    const referralFacts = [...facts, { id: "F19", dato: "Recompensa hipotética de referidos del 1 % después de la primera remesa." }];
    const alternatives = proposal().alternativas.map(item => ({ ...item }));
    alternatives[2] = { ...alternatives[2], nombre: "Referidos con recompensa condicionada",
        mecanismo: "Adquisición por recomendación de clientes", evidenciaIds: ["F19"],
        accionRecomendada: "Evaluar una recompensa del 1 % solo tras primera transferencia confirmada" };
    const evaluated = service.normalizeProposal(proposal({ alternativas: alternatives }), referralFacts);
    assert.equal(evaluated.alternativesValid, true);
    const omitted = service.normalizeProposal(proposal(), referralFacts);
    assert.equal(omitted.alternativesValid, false);
});

test("la comparación real exige evidencia para recuperación, segunda remesa, referidos y conversión", () => {
    const comparisonFacts = ["F19", "F20", "F21", "F23"].map(id => ({ id, dato: `Hecho agregado ${id}` }));
    const alternatives = [
        { id: "A", nombre: "Recuperación selectiva", mecanismo: "Retomar cotización abandonada por señal verificable", evidenciaIds: ["F20"], accionRecomendada: "Revisar candidatos", pasos: ["Verificar elegibilidad"] },
        { id: "B", nombre: "Segunda remesa", mecanismo: "Acompañamiento de recurrencia después de primera operación", evidenciaIds: ["F21"], accionRecomendada: "Medir cohorte", pasos: ["Definir maduración"] },
        { id: "C", nombre: "Referidos", mecanismo: "Captación por recomendación y recompensa condicionada", evidenciaIds: ["F19"], accionRecomendada: "Evaluar recompensa 1 % después de primera remesa", pasos: ["Validar economía"] },
        { id: "D", nombre: "Conversión PIX", mecanismo: "Mejora guiada del proceso de pago y cotización", evidenciaIds: ["F23"], accionRecomendada: "Auditar abandono de proceso", pasos: ["Medir embudo"] }
    ];
    const complete = service.normalizeProposal(proposal({ alternativas: alternatives, estrategiaElegidaId: "A" }), comparisonFacts);
    assert.equal(complete.alternativesValid, true);
    const incomplete = service.normalizeProposal(proposal({ alternativas: alternatives.slice(0, 3), estrategiaElegidaId: "A" }), comparisonFacts);
    assert.equal(incomplete.alternativesValid, false);
});

test("una comparación incompleta no dispara una segunda llamada pagada", async () => {
    let calls = 0;
    const result = await service.generateCommercialProposal({ completeJson: async () => {
        calls++;
        return { data: proposal({ alternativas: proposal().alternativas.slice(0, 1) }) };
    } }, "hechos comerciales", facts);
    assert.equal(calls, 1);
    assert.equal(result.alternativesValid, false);
});

test("el contexto compacto no serializa decisiones completas ni conversaciones", () => {
    const current = { id: 7, estado: "VIGENTE", decision: "Prioridad", problema: "P", evidencia: [{ id: "F3" }],
        impacto: 70, confianza: 80, snapshot: { estrategiaElegida: { id: "S1", nombre: "X", mecanismo: "Y" },
            alternativas: [{ material: "texto grande" }], observacionesResultado: [{ metricas: { remesas: 2 }, variacionDesdeDecision: { remesas: 1 } }] } };
    const context = service.buildDecisionContext(facts, current, { estado: "BORRADOR", señalesOperador: [{ tipo: "EDITADO", campos: ["materiales"], contenido: "PII ignorada" }] });
    assert.match(context, /VIGENTE/);
    assert.match(context, /"remesas":2/);
    assert.doesNotMatch(context, /texto grande|PII ignorada|alternativas/);
    assert.match(service.DECISION_SYSTEM, /A\).*recuperación/);
    assert.match(service.DECISION_SYSTEM, /B\).*segunda transferencia/);
    assert.match(service.DECISION_SYSTEM, /C\).*referidos/);
    assert.match(service.DECISION_SYSTEM, /D\).*mejora de conversión/);
});

test("la evidencia de promociones compacta datos económicos calculados y no transmite el catálogo entero", () => {
    const context = { disponible: true, updatedAt: "2026-10-14T10:00:00Z", escenarios: [
        { importeTransferenciaBRL: 100, nivelVip: 0, normal: { tasa: 180, recibeCUP: 18000 },
            descuentos: [{ porcentaje: 1, costoBeneficioBRL: 1 }, { porcentaje: 2, costoBeneficioBRL: 2 }],
            mejorasTasa: [{ porcentaje: 1, recibePromocionCUP: 18180, costoBeneficioBRL: 1 }, { porcentaje: 2, recibePromocionCUP: 18360, costoBeneficioBRL: 2 }] },
        { importeTransferenciaBRL: 100, nivelVip: 1, normal: { tasa: 182, recibeCUP: 18200 }, descuentos: [], mejorasTasa: [] }
    ] };
    const evidence = service.compactPromotionEvidence(context);
    assert.match(evidence, /18000 CUP @180/);
    assert.match(evidence, /cuesta 1\.00\/2\.00 BRL/);
    assert.match(evidence, /18180\/18360 CUP/);
    assert.doesNotMatch(evidence, /nivelVip|\[\{/);
});

test("detecta alternativas que solo parafrasean el mismo mecanismo", () => {
    assert.equal(service.mechanismsAreDistinct([
        { mecanismo: "Campaña de mensajes para recuperar cotizaciones" },
        { mecanismo: "Mensajes de campaña para recuperar las cotizaciones" },
        { mecanismo: "Programa de referidos de clientes" }
    ]), false);
});

test("registra variaciones comerciales observadas sin presentarlas como causalidad", () => {
    const before = { snapshot: { metricasBase: { conversaciones24h: 10, cotizaciones24h: 4, remesasCompletadas24h: 2 },
        observacionesResultado: [] } };
    const after = { conversaciones24h: 12, cotizaciones24h: 3, remesas24h: 4,
        clientesConRemesa30d: 20, volumenRemesas30d: 900, capturadoAt: "2026-10-14T12:00:00Z" };
    const result = service.withOutcomeObservation(after, before, [], null);
    assert.deepEqual(result.observacionesResultado[0].variacionDesdeDecision,
        { conversaciones24h: 2, cotizaciones24h: -1, remesasCompletadas24h: 2 });
    assert.match(result.observacionesResultado[0].nota, /no atribuye causalidad/);
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
    const queries = [];
    const db = {
        query: async sql => {
            queries.push(String(sql));
            return { rows: [{
                conversaciones_24h: "10", conversaciones_media_7d: "7.285",
                cotizaciones_24h: "4", cotizaciones_media_7d: "3",
                cotizaciones_sin_cierre_48h: "6", abandonos_7d: "2",
                operaciones_24h: "3", operaciones_media_7d: "2.2",
                remesas_24h: "2", remesas_media_7d: "1.5", operaciones_pendientes_48h: "1",
                miembros_grupo: "120", altas_grupo_24h: "3", bajas_grupo_24h: "1",
                publicaciones_7d: "2", tasas_actualizadas_at: new Date("2026-10-13T10:00:00Z"),
                capturado_at: new Date("2026-10-13T12:00:00Z")
            }] };
        }
    };
    const snapshot = await service.collectCommercialSnapshot(db);
    assert.equal(snapshot.conversaciones24h, 10);
    assert.equal(snapshot.conversacionesMedia7d, 7.3);
    assert.match(service.snapshotFacts(snapshot)[2].dato, /6 cotizaciones/);
    assert.match(service.snapshotFacts(snapshot).find(fact => fact.id === "F19").dato, /referidos.*1 %/i);
    assert.equal(snapshot.funnel.primerasRemesas30d, 0);
    assert.match(queries[0], /primeras_remesas_30d/);
    assert.match(queries[0], /contactos_con_respuesta_30d/);
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
    assert.match(ui, /Ganancia incremental:/);
    assert.match(ui, /no estimable con los datos actuales/);
    assert.match(ui, /no son predicciones ni probabilidades/);
});
