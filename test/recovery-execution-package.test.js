"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const service = require("../src/services/director/recovery-execution-package");

const decision = {
    id: 12,
    estado: "VIGENTE",
    decision: "Recuperar clientes en abandono",
    problema: "Existen intentos abandonados.",
    accionRecomendada: "Reactivar clientes recuperables.",
    resultadoEsperado: "Conseguir más remesas.",
    evidencia: [{ id: "F4", dato: "20 abandonos en 7 días." }]
};

const candidates = [
    {
        phone: "5511999990001", nombre: "Ana", estado: "aguardando_comprovante",
        prioridad: "alta", servicio: "CUP transferencia", tipoFavorito: "brl_cup",
        ultimoMonto: 200, fechaIntento: "2026-10-13T09:00:00Z", antiguedad: "reciente"
    },
    {
        phone: "5511999990002", nombre: "Luis", estado: "cotizacion_realizada",
        prioridad: "media", servicio: "MLC", tipoFavorito: "mlc",
        ultimoMonto: 300, fechaIntento: "2026-10-01T09:00:00Z", antiguedad: "recuperacion"
    }
];

test("solo la decisión vigente de recuperación de abandonos genera este paquete", () => {
    assert.equal(service.isRecoveryDecision(decision), true);
    assert.equal(service.isRecoveryDecision({ ...decision, estado: "EJECUTADA" }), false);
    assert.equal(service.isRecoveryDecision({ ...decision, evidencia: [] }), false);
});

test("prepara lista, segmentos, mensajes, secuencia, horario, campaña, publicaciones y métricas", () => {
    const content = service.buildPackageContent(decision, candidates, new Date("2026-10-13T12:00:00Z"));
    assert.equal(content.segmento.total, 2);
    assert.equal(content.segmento.altaPrioridad, 1);
    assert.equal(content.clientes.length, 2);
    assert.ok(content.clientes.every(client => client.mensaje && client.familia));
    assert.equal(content.mensajes.totalPreparados, 2);
    assert.equal(content.secuencia.length, 3);
    assert.match(content.horario.primeraVentana, /09:00/);
    assert.match(content.campana.borrador, /2 clientes/);
    assert.equal(content.publicaciones.necesarias, false);
    assert.ok(content.metricas.some(metric => metric.nombre === "Remesas recuperadas"));
});

test("los mensajes quedan determinados por decisión y cliente para no cambiar en cada revisión", () => {
    const one = service.buildPackageContent(decision, candidates, new Date("2026-10-13T12:00:00Z"));
    const two = service.buildPackageContent(decision, candidates, new Date("2026-10-13T13:00:00Z"));
    assert.deepEqual(one.clientes.map(client => client.mensaje), two.clientes.map(client => client.mensaje));
});

test("ensure crea una sola vez el paquete usando los candidatos existentes", async () => {
    const calls = [];
    const db = { query: async (sql, params) => {
        calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
        if (String(sql).startsWith("SELECT * FROM director_execution_packages")) return { rows: [] };
        if (String(sql).includes("INSERT INTO director_execution_packages")) return { rows: [{
            id: 4, decision_id: 12, tipo: service.PACKAGE_TYPE, estado: "BORRADOR",
            contenido: JSON.parse(params[2]), creado_at: new Date(), actualizado_at: new Date()
        }] };
        return { rows: [] };
    } };
    const result = await service.ensureRecoveryPackage(decision, db, { getCandidates: async executor => {
        assert.equal(executor, db);
        return candidates;
    }, now: new Date("2026-10-13T12:00:00Z") });
    assert.equal(result.id, 4);
    assert.equal(result.contenido.clientes.length, 2);
    assert.equal(calls.filter(call => /INSERT INTO/.test(call.sql)).length, 1);
});

test("no guarda un paquete vacío si falla la consulta de elegibilidad", async () => {
    let inserted = false;
    const db = { query: async sql => {
        if (String(sql).startsWith("SELECT * FROM director_execution_packages")) return { rows: [] };
        inserted = true;
        return { rows: [] };
    } };
    await assert.rejects(service.ensureRecoveryPackage(decision, db, {
        getCandidates: async () => { throw new Error("DB unavailable"); }
    }), /DB unavailable/);
    assert.equal(inserted, false);
});

test("el operador puede modificar el borrador sin alterar clientes ni evidencia", () => {
    const current = service.buildPackageContent(decision, candidates);
    const edited = service.normalizeEditableContent({
        objetivo: "Objetivo revisado",
        campana: { nombre: "Campaña revisada", borrador: "Nuevo borrador" },
        horario: { primeraVentana: "10:00–11:00" },
        clientes: [{ phone: candidates[0].phone, incluido: false }, { phone: candidates[1].phone, mensaje: "Mensaje revisado" }]
    }, current);
    assert.equal(edited.objetivo, "Objetivo revisado");
    assert.equal(edited.campana.nombre, "Campaña revisada");
    assert.equal(edited.horario.primeraVentana, "10:00–11:00");
    assert.equal(edited.clientes[0].incluido, false);
    assert.equal(edited.clientes[1].mensaje, "Mensaje revisado");
    assert.equal(edited.segmento.total, 1);
    assert.equal(edited.campana.borrador, "Nuevo borrador");
    const selectionEdited = service.normalizeEditableContent({
        campana: { borrador: current.campana.borrador },
        clientes: [{ phone: candidates[0].phone, incluido: false }, { phone: candidates[1].phone, incluido: true }]
    }, current);
    assert.match(selectionEdited.campana.borrador, /Revisar 1 cliente elegible/);
    assert.match(selectionEdited.campana.borrador, /continuar con 1 que cotizaron/);
});

test("migración, API e interfaz mantienen el paquete en revisión sin envío automático", () => {
    const root = path.join(__dirname, "..");
    const migration = fs.readFileSync(path.join(root, "migrations/0032_recovery_execution_package.sql"), "utf8");
    const routes = fs.readFileSync(path.join(root, "src/routes/content-library.js"), "utf8");
    const ui = fs.readFileSync(path.join(root, "public/content-center.html"), "utf8");
    const packageCode = fs.readFileSync(path.join(root, "src/services/director/recovery-execution-package.js"), "utf8");
    assert.match(migration, /BORRADOR.*APROBADO.*CANCELADO/s);
    assert.match(routes, /director\/decision\/\:id\/package/);
    assert.match(routes, /director\/execution-package\/\:id\/\:action/);
    assert.match(ui, /Paquete de ejecución/);
    assert.match(ui, /Aprobar paquete/);
    assert.doesNotMatch(packageCode, /enviarMensaje|zapi/);
});
