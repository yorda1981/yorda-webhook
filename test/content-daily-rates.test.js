"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
    renderDailyRates, localParts, ensureDailyRatesSchedule, ensureDailyAdminRatesSchedule, sendAdminRates, getDailyRatesSettings,
    updateDailyRatesSettings
} = require("../src/services/content-daily-rates");

const RATES = {
    brl_0: 160, brl_100: 178, brl_500: 180, brl_1000: 182,
    usd1: 5.5, usd2: 5.4, mlc: 5, efectivo: 120,
    updated_at: "2026-10-14T12:00:00Z"
};

test("las tasas se preparan exclusivamente con los valores reales recibidos", () => {
    const body = renderDailyRates(RATES);
    assert.match(body, /CUP 160/);
    assert.match(body, /USD 5,5/);
    assert.match(body, /USD 5,4/);
    assert.match(body, /MLC 5/);
    assert.match(body, /Efectivo en CUP: R\$ 1 = CUP 120/);
    assert.match(body, /Escríbele al bot de YORDA por privado/);
    assert.throws(() => renderDailyRates({ ...RATES, brl_500: null }), /no son válidas/);
});

test("fecha y hora del trabajo diario se interpretan en la zona del grupo", () => {
    assert.deepEqual(localParts(new Date("2026-10-15T12:00:00Z")), { date: "2026-10-15", time: "09:00" });
});

test("recupera en la cola persistente si el scheduler despierta después de la hora", async () => {
    const calls = [];
    let insertParams;
    const db = {
        async query(sql) {
            calls.push(String(sql));
            if (/SELECT id, nombre, tasas_habilitadas/.test(sql)) {
                return { rows: [{ id: "1", nombre: "Grupo", tasas_habilitadas: true, tasas_hora: "09:00" }] };
            }
            if (/SELECT id, estado FROM content_schedules/.test(sql)) return { rows: [] };
            throw new Error(`Consulta inesperada: ${sql}`);
        },
        async connect() {
            return {
                async query(sql, params) {
                    calls.push(String(sql));
                    if (/SELECT pg_advisory_xact_lock/.test(sql)) return { rows: [] };
                    if (/SELECT id, estado FROM content_schedules/.test(sql)) return { rows: [] };
                    if (/SELECT \* FROM rates/.test(sql)) return { rows: [RATES] };
                    if (/SELECT id FROM content_items WHERE origen_sistema/.test(sql)) return { rows: [{ id: "12" }] };
                    if (/SELECT numero, cuerpo FROM content_revisions/.test(sql)) return { rows: [{ numero: 3, cuerpo: "antiguo" }] };
                    if (/INSERT INTO content_schedules/.test(sql)) { insertParams = params; return { rows: [{ id: "48" }] }; }
                    return { rows: [] };
                },
                release() { calls.push("release"); }
            };
        }
    };
    const result = await ensureDailyRatesSchedule({ db, now: new Date("2026-10-15T12:01:15Z") });
    assert.equal(result.status, "SCHEDULED");
    assert.equal(result.scheduleId, 48);
    assert.ok(calls.some(sql => /INSERT INTO content_schedules/.test(sql)));
    assert.ok(calls.some(sql => /INSERT INTO content_events/.test(sql)));
    assert.equal(new Date(insertParams[0]).toISOString(), "2026-10-15T12:00:00.000Z");
    assert.equal(insertParams[1], "PENDIENTE");
    assert.equal(insertParams[2], "daily-rates-2026-10-15");
});

test("tasas idénticas pueden publicarse al día siguiente con una nueva clave diaria", async () => {
    const insertedKeys = [];
    let nextId = 60;
    const db = {
        async query(sql) {
            if (/SELECT id, nombre, tasas_habilitadas/.test(sql)) return { rows: [{ id: "1", nombre: "Grupo", tasas_habilitadas: true, tasas_hora: "09:00" }] };
            if (/SELECT id, estado FROM content_schedules/.test(sql)) return { rows: [] };
            throw new Error(`Consulta inesperada: ${sql}`);
        },
        async connect() {
            return { async query(sql, params) {
                if (/SELECT \* FROM rates/.test(sql)) return { rows: [RATES] };
                if (/SELECT id FROM content_items WHERE origen_sistema/.test(sql)) return { rows: [{ id: "12" }] };
                if (/SELECT numero, cuerpo FROM content_revisions/.test(sql)) return { rows: [{ numero: 3, cuerpo: renderDailyRates(RATES) }] };
                if (/INSERT INTO content_schedules/.test(sql)) { insertedKeys.push(params[2]); return { rows: [{ id: String(nextId++) }] }; }
                return { rows: [] };
            }, release() {} };
        }
    };
    const first = await ensureDailyRatesSchedule({ db, now: new Date("2026-10-15T12:01:15Z") });
    const second = await ensureDailyRatesSchedule({ db, now: new Date("2026-10-16T12:01:15Z") });
    assert.equal(first.status, "SCHEDULED");
    assert.equal(second.status, "SCHEDULED");
    assert.deepEqual(insertedKeys, ["daily-rates-2026-10-15", "daily-rates-2026-10-16"]);
});

test("una publicación de tasas del mismo grupo y día no se programa dos veces", async () => {
    let connects = 0;
    const db = {
        async query(sql) {
            if (/SELECT id, nombre, tasas_habilitadas/.test(sql)) return { rows: [{ id: "1", nombre: "Grupo", tasas_habilitadas: true, tasas_hora: "09:00" }] };
            if (/SELECT id, estado FROM content_schedules/.test(sql)) return { rows: [{ id: "62", estado: "PENDIENTE" }] };
            throw new Error(`Consulta inesperada: ${sql}`);
        },
        async connect() { connects += 1; throw new Error("No debe abrir transacción al encontrar la clave diaria existente."); }
    };
    const result = await ensureDailyRatesSchedule({ db, now: new Date("2026-10-15T13:00:00Z") });
    assert.deepEqual(result, { status: "ALREADY_SCHEDULED", scheduleId: 62, state: "PENDIENTE" });
    assert.equal(connects, 0);
});

test("el destino administrativo recupera tarde de forma independiente y conserva su propia idempotencia", async () => {
    const keys = [];
    const db = {
        async query(sql) {
            if (/SELECT id, estado FROM content_schedules/.test(sql)) return { rows: [] };
            throw new Error(`Consulta inesperada: ${sql}`);
        },
        async connect() {
            return { async query(sql, params) {
                if (/SELECT \* FROM rates/.test(sql)) return { rows: [RATES] };
                if (/SELECT id FROM content_items WHERE origen_sistema/.test(sql)) return { rows: [{ id: "12" }] };
                if (/SELECT numero, cuerpo FROM content_revisions/.test(sql)) return { rows: [{ numero: 3, cuerpo: renderDailyRates(RATES) }] };
                if (/INSERT INTO content_schedules/.test(sql)) { keys.push(params[2]); return { rows: [{ id: "61" }] }; }
                return { rows: [] };
            }, release() {} };
        }
    };
    const result = await ensureDailyAdminRatesSchedule({ db, now: new Date("2026-10-15T13:16:15Z") });
    assert.equal(result.status, "SCHEDULED");
    assert.deepEqual(keys, ["daily-rates-admin-2026-10-15"]);
});

test("la migración permite el origen system requerido por el activo diario de tasas", () => {
    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "0039_daily_rates_system_content_origin.sql"), "utf8");
    assert.match(migration, /CHECK\s*\(origen IN \('operador', 'director', 'system'\)\)/i);
});

test("horario configurable valida y persiste la hora local", async () => {
    let parameters;
    const db = { async query(sql, values) {
        parameters = values;
        return { rows: [{ id: "1", nombre: "Grupo", tasas_habilitadas: values[0], tasas_hora: values[1] }] };
    }};
    const result = await updateDailyRatesSettings({ enabled: true, time: "10:25" }, db);
    assert.deepEqual(parameters, [true, "10:25"]);
    assert.equal(result.time, "10:25");
    await assert.rejects(() => updateDailyRatesSettings({ enabled: true, time: "25:99" }, db), { code: "CONTENT_DAILY_RATES_VALIDATION" });
});

test("restaura la entrega administrativa diaria a las 10:15 con idempotencia propia", async () => {
    const calls = [];
    let inserted = false;
    const db = {
        async query(sql) {
            calls.push(String(sql));
            if (/SELECT id, estado FROM content_schedules/.test(sql)) return { rows: inserted ? [{ id: "49", estado: "PENDIENTE" }] : [] };
            throw new Error(`Consulta inesperada: ${sql}`);
        },
        async connect() {
            return {
                async query(sql, params) {
                    calls.push(String(sql));
                    if (/SELECT pg_advisory_xact_lock/.test(sql)) return { rows: [] };
                    if (/SELECT id, estado FROM content_schedules/.test(sql)) return { rows: inserted ? [{ id: "49", estado: "PENDIENTE" }] : [] };
                    if (/SELECT \* FROM rates/.test(sql)) return { rows: [RATES] };
                    if (/SELECT id FROM content_items WHERE origen_sistema/.test(sql)) return { rows: [{ id: "12" }] };
                    if (/SELECT numero, cuerpo FROM content_revisions/.test(sql)) return { rows: [{ numero: 3, cuerpo: "anterior" }] };
                    if (/INSERT INTO content_schedules/.test(sql)) { inserted = true; return { rows: [{ id: "49" }] }; }
                    return { rows: [] };
                },
                release() {}
            };
        }
    };
    const result = await ensureDailyAdminRatesSchedule({ db, now: new Date("2026-10-15T13:15:20Z") });
    assert.equal(result.status, "SCHEDULED");
    assert.ok(calls.some(sql => /INSERT INTO content_schedules/.test(sql)));
    assert.ok(calls.some(sql => /INSERT INTO content_events/.test(sql)));
    assert.equal((await ensureDailyAdminRatesSchedule({ db, now: new Date("2026-10-15T13:16:00Z") })).status, "ALREADY_SCHEDULED");
});

test("el envío administrativo usa el cuerpo vigente y registra éxito o fallo separado", async () => {
    const calls = [];
    const db = { async query(sql, params) {
        calls.push({ sql: String(sql), params });
        if (/SELECT cuerpo FROM content_revisions/.test(sql)) return { rows: [{ cuerpo: renderDailyRates(RATES) }] };
        return { rows: [] };
    } };
    const schedule = { scheduleId: 51, contentId: 12 };
    const success = await sendAdminRates(schedule, { pool: db, adminPhone: "5511999", send: async (phone, body) => {
        assert.equal(phone, "5511999");
        assert.match(body, /CUP 160/);
        return true;
    } });
    assert.equal(success.code, "PUBLISHED");
    assert.ok(calls.some(call => /CONTENT_DAILY_RATES_ADMIN_SENT/.test(call.sql)));
    assert.ok(calls.some(call => /CONTENT_DAILY_RATES_ADMIN_STARTED/.test(call.sql) && /\$2::bigint/.test(call.sql)));
    assert.ok(calls.some(call => /CONTENT_DAILY_RATES_ADMIN_SENT/.test(call.sql) && /\$2::bigint/.test(call.sql)));
    const failure = await sendAdminRates(schedule, { pool: db, adminPhone: "5511999", send: async () => false });
    assert.equal(failure.code, "SEND_FAILED");
    assert.ok(calls.some(call => /CONTENT_DAILY_RATES_ADMIN_SEND_FAILED/.test(call.sql)));
});

test("un fallo registrando el inicio queda trazado y no llama a Z-API", async () => {
    const calls = [];
    let sent = false;
    const db = { async query(sql) {
        calls.push(String(sql));
        if (/CONTENT_DAILY_RATES_ADMIN_STARTED/.test(sql)) throw new Error("audit write failed");
        return { rows: [] };
    } };
    const result = await sendAdminRates({ scheduleId: 52, contentId: 12 }, {
        pool: db,
        adminPhone: "5511999",
        send: async () => { sent = true; return true; }
    });
    assert.equal(result.ok, false);
    assert.equal(sent, false);
    assert.ok(calls.some(sql => /CONTENT_DAILY_RATES_ADMIN_SEND_FAILED/.test(sql)));
});
