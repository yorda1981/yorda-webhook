"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — conversión de hora local de Brasil (America/Sao_Paulo)
// <-> UTC (src/utils/timezone.js), usada por la fecha límite opcional de
// Recarga Internacional (migración 0013). Nunca debe compararse como string
// ambiguo -- disponible_hasta se guarda como TIMESTAMPTZ (instante absoluto),
// y esta es la conversión desde/hacia "lo que el admin escribe en el
// dashboard" (hora local de Brasil, sin zona horaria explícita).
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const { saoPauloLocalAUTC, utcASaoPauloLocal, ZONA_NEGOCIO } = require("../src/utils/timezone");

test("ZONA_NEGOCIO es America/Sao_Paulo", () => {
    assert.equal(ZONA_NEGOCIO, "America/Sao_Paulo");
});

test("saoPauloLocalAUTC: 23:59 hora de Brasil -> 02:59 UTC del día siguiente (offset -03:00)", () => {
    const d = saoPauloLocalAUTC("2026-09-24T23:59");
    assert.equal(d.toISOString(), "2026-09-25T02:59:00.000Z");
});

test("saoPauloLocalAUTC: mediodía -> +3 horas en UTC", () => {
    const d = saoPauloLocalAUTC("2026-06-15T12:00");
    assert.equal(d.toISOString(), "2026-06-15T15:00:00.000Z");
});

test("saoPauloLocalAUTC: string vacío/null -> null, nunca inventa una fecha", () => {
    assert.equal(saoPauloLocalAUTC(""), null);
    assert.equal(saoPauloLocalAUTC(null), null);
    assert.equal(saoPauloLocalAUTC(undefined), null);
});

test("saoPauloLocalAUTC: string con formato inválido -> null", () => {
    assert.equal(saoPauloLocalAUTC("no es una fecha"), null);
    assert.equal(saoPauloLocalAUTC("2026-13-99"), null);
});

test("utcASaoPauloLocal: round-trip exacto de vuelta al mismo string local", () => {
    const local = "2026-09-24T23:59";
    const utc = saoPauloLocalAUTC(local);
    assert.equal(utcASaoPauloLocal(utc), local);
});

test("utcASaoPauloLocal: fecha vacía/inválida -> string vacío", () => {
    assert.equal(utcASaoPauloLocal(null), "");
    assert.equal(utcASaoPauloLocal("no es una fecha"), "");
});

// ── Escenario del enunciado: vence durante el flujo (23:55 empieza, 23:59 vence, 00:02 continúa) ──
test("escenario 23:55/23:59/00:02: un límite fijado a las 23:59 ya está vencido al comparar contra las 00:02 del día siguiente", () => {
    const limite = saoPauloLocalAUTC("2026-09-24T23:59"); // fijado por el admin
    const ahoraEnElFlujo = saoPauloLocalAUTC("2026-09-24T23:55"); // cliente empieza -- todavía activo
    const ahoraAlContinuar = saoPauloLocalAUTC("2026-09-25T00:02"); // cliente continúa -- ya vencido

    assert.ok(ahoraEnElFlujo.getTime() <= limite.getTime(), "a las 23:55 la modalidad todavía debía estar disponible");
    assert.ok(ahoraAlContinuar.getTime() > limite.getTime(), "a las 00:02 del día siguiente ya debe considerarse vencida");
});
