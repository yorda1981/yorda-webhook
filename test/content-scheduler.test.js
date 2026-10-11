"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    SCHEDULE_STATES,
    normalizeScheduledAt,
    schedulePublication,
    outcomeForPublisherResult,
    executeClaimedSchedule,
    startPersistentScheduler
} = require("../src/services/content-scheduler");

test("programación exige instante futuro con zona horaria explícita", () => {
    const now = new Date("2026-10-11T12:00:00.000Z");
    assert.equal(normalizeScheduledAt("2026-10-11T15:30:00-03:00", now).toISOString(), "2026-10-11T18:30:00.000Z");
    assert.throws(() => normalizeScheduledAt("2026-10-11T15:30:00", now), { code: "CONTENT_SCHEDULER_VALIDATION" });
    assert.throws(() => normalizeScheduledAt("2026-10-11T11:00:00Z", now), { code: "CONTENT_SCHEDULER_VALIDATION" });
});

test("programar persiste una sola fila y su evento con la misma idempotency key", async () => {
    let captured;
    const db = { async query(sql, params) {
        captured = { sql: String(sql).replace(/\s+/g, " ").trim(), params };
        return { rows: [{
            id: "8", idioma: "es", programada_para: params[1], estado: "PENDIENTE",
            idempotency_key: params[3], publication_id: null
        }] };
    }};
    const result = await schedulePublication({
        idioma: "es",
        programadaPara: "2026-10-12T12:00:00Z",
        idempotencyKey: "schedule-8"
    }, { pool: db, now: new Date("2026-10-11T12:00:00Z") });
    assert.equal(result.alreadyExisted, false);
    assert.equal(result.schedule.estado, "PENDIENTE");
    assert.match(captured.sql, /INSERT INTO content_schedules/);
    assert.match(captured.sql, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
    assert.match(captured.sql, /CONTENT_SCHEDULE_CREATED/);
    assert.deepEqual(captured.params, ["es", "2026-10-12T12:00:00.000Z", "PENDIENTE", "schedule-8"]);
});

test("resultado del Motor de Publicación se traduce sin reglas de contenido", () => {
    assert.equal(outcomeForPublisherResult({ code: "PUBLISHED" }), SCHEDULE_STATES.EXECUTED);
    assert.equal(outcomeForPublisherResult({ code: "ALREADY_REGISTERED", publication: { estado: "PUBLICADA" } }), SCHEDULE_STATES.EXECUTED);
    assert.equal(outcomeForPublisherResult({ code: "AMBIGUOUS_RESULT" }), SCHEDULE_STATES.AMBIGUOUS);
    assert.equal(outcomeForPublisherResult({ code: "ALREADY_REGISTERED", publication: { estado: "PUBLICANDO" } }), SCHEDULE_STATES.AMBIGUOUS);
    assert.equal(outcomeForPublisherResult({ code: "SEND_FAILED" }), SCHEDULE_STATES.FAILED);
});

test("ejecutor entrega únicamente idioma e idempotency key al Motor de Publicación", async () => {
    const calls = [];
    const schedule = { scheduleId: 8, idioma: "pt", idempotencyKey: "schedule-8", estado: "EJECUTANDO" };
    const result = await executeClaimedSchedule(schedule, {
        pool: {},
        publisher: { async publishSelectedContent(input) { calls.push(["publish", input]); return { code: "PUBLISHED", publication: { publicationId: 12 } }; } },
        finishFn: async (receivedSchedule, publisherResult) => {
            calls.push(["finish", receivedSchedule, publisherResult]);
            return { ...schedule, estado: "EJECUTADA" };
        }
    });
    assert.deepEqual(calls[0], ["publish", { idioma: "pt", idempotencyKey: "schedule-8" }]);
    assert.equal(calls[1][2].publication.publicationId, 12);
    assert.equal(result.estado, "EJECUTADA");
});

test("arranque recupera claims abandonados antes del primer barrido", async () => {
    const calls = [];
    const scheduler = startPersistentScheduler({
        pool: {}, intervalMs: 60_000,
        recoverFn: async () => { calls.push("recover"); return 1; },
        runFn: async () => { calls.push("run"); return []; }
    });
    await scheduler.ready;
    scheduler.stop();
    assert.deepEqual(calls, ["recover", "run"]);
});

test("migración define cola durable, estados terminales e índice de pendientes", () => {
    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "0026_content_scheduler.sql"), "utf8");
    assert.match(migration, /CREATE TABLE IF NOT EXISTS content_schedules/);
    assert.match(migration, /idempotency_key\s+VARCHAR\(160\) NOT NULL UNIQUE/);
    assert.match(migration, /publication_id\s+BIGINT REFERENCES content_publications\(id\)/);
    assert.match(migration, /WHERE estado = 'PENDIENTE'/);
    assert.match(migration, /'SCHEDULE'/);
});

test("claims son atómicos, ordenados y seguros entre instancias", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "content-scheduler.js"), "utf8");
    assert.match(source, /FOR UPDATE SKIP LOCKED/);
    assert.match(source, /WHERE estado = \$1 AND programada_para <= NOW\(\)/);
    assert.match(source, /CONTENT_SCHEDULE_CLAIMED/);
    assert.match(source, /CONTENT_SCHEDULE_RECOVERED/);
});

test("cancelación solo puede afectar una programación pendiente", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "content-scheduler.js"), "utf8");
    assert.match(source, /WHERE id = \$1 AND estado = \$3/);
    assert.match(source, /CONTENT_SCHEDULE_CANCELED/);
});

test("scheduler no contiene selección, render ni transporte", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "content-scheduler.js"), "utf8");
    assert.doesNotMatch(source, /selectContent|renderContent|enviarMensaje|zapi|whatsapp|telegram|Math\.random/i);
    assert.doesNotMatch(source, /content_revisions|cuerpo_renderizado/);
    assert.match(source, /publisher\.publishSelectedContent/);
});

test("API permite programar y cancelar, sin recurrencias ni pantallas nuevas", () => {
    const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "content-library.js"), "utf8");
    assert.match(routes, /router\.post\("\/schedules", adminWriteLimiter, verificarToken/);
    assert.match(routes, /router\.post\("\/schedules\/:id\/cancel", adminWriteLimiter, verificarToken/);
    const publicFiles = fs.readdirSync(path.join(__dirname, "..", "public"));
    assert.equal(publicFiles.filter((name) => /schedule|programacion/i.test(name)).length, 0);
});
