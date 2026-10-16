"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { getOperationsSnapshot } = require("../src/services/content-operations");

test("consolida métricas, programación, publicación, eventos, destinos y servicios", async () => {
    const db = { async query(sql) {
        if (sql.includes("COUNT(*) FILTER")) return { rows: [{ programadas: 2, ejecutadas: 5, fallidas: 1, canceladas: 3 }] };
        if (sql.includes("FROM content_publications cp")) return { rows: [{ id: 9, titulo: "Confianza", canal: "whatsapp_group" }] };
        if (sql.includes("FROM content_schedules") && sql.includes("LIMIT 1")) return { rows: [{ idioma: "es", programada_para: "2026-10-12T12:00:00Z" }] };
        if (sql.includes("FROM content_events")) return { rows: [{ event_type: "CONTENT_PUBLICATION_PUBLISHED" }] };
        if (sql.includes("FROM content_destinations")) return { rows: [{ nombre: "Clientes", activo: true }] };
        assert.fail("Consulta operacional inesperada");
    } };
    const snapshot = await getOperationsSnapshot(db, { schedulerStarted: true, outbound: { getSnapshot: async () => ({ settings: { paused: true }, counts: {}, pending: [], nextSendAt: null }) } });
    assert.deepEqual(snapshot.counts, { programadas: 2, ejecutadas: 5, fallidas: 1, canceladas: 3 });
    assert.equal(snapshot.latestPublication.titulo, "Confianza");
    assert.equal(snapshot.nextSchedule.idioma, "es");
    assert.equal(snapshot.events[0].event_type, "CONTENT_PUBLICATION_PUBLISHED");
    assert.equal(snapshot.destinations[0].nombre, "Clientes");
    assert.equal(snapshot.services.scheduler, "INICIADO");
    assert.ok(["CONFIGURADO", "CONFIGURACIÓN INCOMPLETA"].includes(snapshot.services.publisher));
});

test("endpoint operacional está protegido como lectura administrativa", () => {
    const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "content-operations.js"), "utf8");
    assert.match(routes, /router\.get\("\/", adminReadLimiter, verificarToken/);
});

test("pantalla muestra los bloques operacionales requeridos y enlaza desde el dashboard", () => {
    const page = fs.readFileSync(path.join(__dirname, "..", "public", "content-operations.html"), "utf8");
    const dashboard = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    for (const label of ["Programadas", "Ejecutadas", "Fallidas", "Canceladas", "Último contenido publicado", "Próxima programación", "Últimos eventos", "Servicios", "Destinos configurados"]) {
        assert.ok(page.includes(label), `Falta bloque: ${label}`);
    }
    assert.match(dashboard, /href="\/content-operations"/);
});

