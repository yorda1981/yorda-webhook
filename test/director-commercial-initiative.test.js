"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const packageService = require("../src/services/director/recovery-execution-package");

const evidence = [{ id: "F1", dato: "10 conversaciones recientes con el bot." }];

function decision(overrides = {}) {
    const strategy = {
        id: "S1", nombre: "Guía de confianza", mecanismo: "Reducir objeciones con información útil",
        justificacion: "Responde dudas reales", evidencia: evidence, impacto: 70, puntuacionComercial: 65,
        ejecutable: true, requiereCompromisoEconomico: false, pasos: ["Revisar borrador"],
        materiales: [{ tipo: "biblioteca", titulo: "Cómo funciona YORDA", contenido: "Guía explicativa del servicio." }],
        metricas: ["Cotizaciones que completan remesa"], capacidadesFaltantes: []
    };
    return { id: 12, estado: "VIGENTE", decision: strategy.nombre, problema: "Dudas antes de cotizar",
        accionRecomendada: "Preparar una guía", resultadoEsperado: "Más cotizaciones informadas",
        alternativas: [strategy], estrategiaElegida: strategy, evidencia: evidence, ...overrides };
}

test("iniciativa con activo de Biblioteca queda preparada como borrador sin publicar", () => {
    const content = packageService.buildInitiativeContent(decision());
    assert.equal(content.ejecucion.adaptador, "BIBLIOTECA_BORRADOR");
    assert.equal(content.ejecucion.listaParaAprobar, true);
    assert.equal(content.ejecucion.publicacionesAutomaticas, false);
    assert.equal(content.ejecucion.mensajesAutomaticos, false);
});

test("iniciativa que requiere gasto no verificado no se ofrece para aprobar", () => {
    const commercial = decision({ estrategiaElegida: {
        ...decision().estrategiaElegida, requiereCompromisoEconomico: true
    } });
    assert.equal(packageService.buildInitiativeContent(commercial).ejecucion.listaParaAprobar, false);
});

test("aprobación crea el borrador conectado a Biblioteca, pero no publica", async () => {
    const row = { id: 9, decision_id: 12, tipo: "INICIATIVA_COMERCIAL", estado: "BORRADOR",
        contenido: packageService.buildInitiativeContent(decision()) };
    const calls = [];
    const db = { query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes("SELECT * FROM director_execution_packages")) return { rows: [row] };
        if (sql.includes("UPDATE director_execution_packages")) {
            row.estado = params[1]; row.contenido = JSON.parse(params[2]);
            return { rows: [row] };
        }
        throw new Error("consulta inesperada");
    } };
    const drafts = [];
    const result = await packageService.resolvePackage(9, "approve", db, {
        createDirectorDraft: async input => { drafts.push(input); return { id: 30, titulo: input.titulo }; }
    });
    assert.equal(drafts.length, 1);
    assert.equal(result.contenido.ejecucion.activosBiblioteca[0].id, 30);
    assert.equal(result.estado, "APROBADO");
    assert.equal(calls.some(call => /PUBLICAR|SEND|WHATSAPP/i.test(call.sql)), false);
    assert.equal(drafts[0].fuentes[0].titulo, evidence[0].dato);
});

test("iniciativa sin integración operativa identifica la capacidad faltante", () => {
    const nonExecutable = decision({ estrategiaElegida: {
        ...decision().estrategiaElegida,
        materiales: [{ tipo: "otro", titulo: "Plan", contenido: "Coordinar acción externa" }]
    } });
    const content = packageService.buildInitiativeContent(nonExecutable);
    assert.equal(content.ejecucion.listaParaAprobar, false);
    assert.match(content.capacidadesFaltantes.join(" "), /adaptador operativo/);
});

test("ediciones del operador se conservan como señal para siguientes decisiones", async () => {
    const row = { id: 19, estado: "BORRADOR", contenido: {
        objetivo: "Objetivo inicial", alternativas: [], estrategiaElegida: { materiales: [] }, materiales: []
    } };
    let updated;
    const db = { query: async (sql, params) => {
        if (sql.includes("SELECT * FROM director_execution_packages")) return { rows: [row] };
        if (sql.includes("UPDATE director_execution_packages")) {
            updated = JSON.parse(params[1]);
            return { rows: [{ ...row, contenido: updated }] };
        }
        throw new Error("consulta inesperada");
    } };
    await packageService.updatePackage(19, { objetivo: "Objetivo modificado por operador", materiales: [] }, db);
    assert.deepEqual(updated.señalesOperador[0].campos, ["objetivo"]);
    assert.equal(updated.señalesOperador[0].tipo, "EDITADO");
});
