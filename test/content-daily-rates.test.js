"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    renderDailyRates, localParts, ensureDailyRatesSchedule, getDailyRatesSettings,
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

test("programa una sola publicación diaria usando la cola persistente existente", async () => {
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
    const result = await ensureDailyRatesSchedule({ db, now: new Date("2026-10-15T12:00:20Z") });
    assert.equal(result.status, "SCHEDULED");
    assert.equal(result.scheduleId, 48);
    assert.ok(calls.some(sql => /INSERT INTO content_schedules/.test(sql)));
    assert.ok(calls.some(sql => /INSERT INTO content_events/.test(sql)));
    assert.equal(new Date(insertParams[0]).toISOString(), "2026-10-15T12:00:00.000Z");
});

test("no crea ni envía la programación diaria fuera del minuto configurado", async () => {
    let connected = false;
    const db = { async query(sql) {
        if (/SELECT id, nombre, tasas_habilitadas/.test(sql)) return { rows: [{ id: "1", nombre: "Grupo", tasas_habilitadas: true, tasas_hora: "09:00" }] };
        return { rows: [] };
    },
        async connect() { connected = true; return { async query(sql) {
            if (/INSERT INTO content_schedules/.test(sql)) return { rows: [{ id: "49" }] };
            return { rows: [] };
        }, release() {} }; } };
    const result = await ensureDailyRatesSchedule({ db, now: new Date("2026-10-15T12:01:00Z") });
    assert.equal(result.status, "MISSED_WINDOW");
    assert.equal(connected, true); // registra el fallo en la cola, sin invocar el publicador
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
