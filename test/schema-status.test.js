"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
    SCHEMA_STATES,
    listMigrationFiles,
    getPendingMigrations,
    createSchemaGate
} = require("../src/services/schema-status");
const { getOperationsSnapshot } = require("../src/services/content-operations");

const FILES = ["0001_base.sql", "0002_extra.sql", "0003_content.sql"];
const root = path.join(__dirname, "..");

function dbWithApplied(applied) {
    return { query: async () => ({ rows: applied.map((name) => ({ name })) }) };
}

function undefinedTableError() {
    const error = new Error('relation "schema_migrations" does not exist');
    error.code = "42P01";
    return error;
}

test("lista migrations/*.sql en orden de aplicación", () => {
    const files = listMigrationFiles();
    assert.ok(files.length > 0);
    assert.deepEqual(files, [...files].sort());
    assert.ok(files.every((f) => f.endsWith(".sql")));
});

test("pendientes: diferencia entre archivos y schema_migrations", async () => {
    assert.deepEqual(await getPendingMigrations(dbWithApplied(["0001_base.sql"]), FILES), ["0002_extra.sql", "0003_content.sql"]);
    assert.deepEqual(await getPendingMigrations(dbWithApplied(FILES), FILES), []);
});

test("pendientes: sin schema_migrations todas están pendientes; otros errores se propagan", async () => {
    assert.deepEqual(await getPendingMigrations({ query: async () => { throw undefinedTableError(); } }, FILES), FILES);
    await assert.rejects(getPendingMigrations({ query: async () => { throw new Error("ECONNREFUSED"); } }, FILES), /ECONNREFUSED/);
});

test("esquema completo: inicia el servicio una sola vez y sin registrar errores", async () => {
    let starts = 0;
    const logs = [];
    const gate = createSchemaGate({ db: dbWithApplied(FILES), files: FILES, start: () => { starts++; }, logError: (m) => logs.push(m) });
    await gate.begin();
    await gate.check();
    gate.stop();
    assert.equal(starts, 1);
    assert.deepEqual(logs, []);
    assert.deepEqual(gate.getStatus(), { estado: SCHEMA_STATES.COMPLETO, pendientes: [] });
});

test("esquema pendiente: no inicia el servicio y registra un único error", async () => {
    let starts = 0;
    const logs = [];
    const gate = createSchemaGate({ db: dbWithApplied(["0001_base.sql"]), files: FILES, start: () => { starts++; }, logError: (m) => logs.push(m) });
    await gate.begin();
    for (let i = 0; i < 5; i++) await gate.check();
    gate.stop();
    assert.equal(starts, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /SCHEMA_PENDING/);
    assert.match(logs[0], /0002_extra\.sql, 0003_content\.sql/);
    assert.deepEqual(gate.getStatus(), { estado: SCHEMA_STATES.PENDIENTE, pendientes: ["0002_extra.sql", "0003_content.sql"] });
});

test("cuando se aplican las migraciones, el servicio arranca sin reiniciar el proceso", async () => {
    let applied = ["0001_base.sql"];
    let starts = 0;
    const gate = createSchemaGate({ db: { query: async () => ({ rows: applied.map((name) => ({ name })) }) }, files: FILES, start: () => { starts++; }, logError: () => {} });
    await gate.begin();
    assert.equal(starts, 0);
    applied = FILES;
    await gate.check();
    await gate.check();
    gate.stop();
    assert.equal(starts, 1);
    assert.equal(gate.getStatus().estado, SCHEMA_STATES.COMPLETO);
});

test("si la base no responde: NO_VERIFICADO, sin iniciar y con un único error", async () => {
    let starts = 0;
    const logs = [];
    const gate = createSchemaGate({ db: { query: async () => { throw new Error("ECONNREFUSED"); } }, files: FILES, start: () => { starts++; }, logError: (m) => logs.push(m) });
    await gate.begin();
    await gate.check();
    gate.stop();
    assert.equal(starts, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /SCHEMA_CHECK_FAILED/);
    assert.equal(gate.getStatus().estado, SCHEMA_STATES.NO_VERIFICADO);
});

test("Centro de Operaciones con esquema pendiente: muestra ESQUEMA PENDIENTE sin tocar tablas content_*", async () => {
    const db = { query: async () => assert.fail("no debe consultar tablas que pueden no existir") };
    const schema = { estado: SCHEMA_STATES.PENDIENTE, pendientes: ["0026_content_scheduler.sql"] };
    const snapshot = await getOperationsSnapshot(db, { schedulerStarted: false, schema });
    assert.equal(snapshot.services.scheduler, "ESQUEMA PENDIENTE");
    assert.deepEqual(snapshot.schema.pendientes, ["0026_content_scheduler.sql"]);
    assert.deepEqual(snapshot.counts, { programadas: 0, ejecutadas: 0, fallidas: 0, canceladas: 0 });
    assert.deepEqual(snapshot.destinations, []);
});

test("Railway ejecuta el migrador como pre-deploy y el migrador toma advisory lock", () => {
    const railway = JSON.parse(fs.readFileSync(path.join(root, "railway.json"), "utf8"));
    assert.deepEqual(railway.deploy.preDeployCommand, ["node scripts/migrate.js"]);
    const migrate = fs.readFileSync(path.join(root, "scripts", "migrate.js"), "utf8");
    assert.match(migrate, /pg_advisory_xact_lock\(\$1\)", \[MIGRATION_LOCK_KEY\]/);
    assert.doesNotMatch(migrate, /pg_advisory_lock\(\$1\)", \[MIGRATION_LOCK_KEY\]/);
    assert.match(migrate, /process\.exit\(1\)/);
});

test("index.js no migra y solo inicia el scheduler a través del schemaGate", () => {
    const index = fs.readFileSync(path.join(root, "index.js"), "utf8");
    assert.doesNotMatch(index, /scripts\/migrate/);
    assert.equal(index.match(/startPersistentScheduler\(\)/g).length, 1);
    assert.match(index, /start: \(\) => \{\s*startPersistentScheduler\(\);\s*marketingSchedulerStarted = true;/);
    assert.match(index, /schemaGate\.begin\(\);/);
    assert.match(index, /getSchemaStatus: \(\) => schemaGate\.getStatus\(\)/);
    assert.doesNotMatch(index, /enviarTasasDiarias|ultimoEnvioTasas/);
});
