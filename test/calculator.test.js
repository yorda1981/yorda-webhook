"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — cálculo de tasas (src/services/calculator.js)
//
// Prueba calcularConTasas(), que es la matemática pura de precios
// (a qué tramo pertenece un monto, qué tasa le toca). No toca la
// base de datos — las tasas se le pasan como si vinieran de ahí.
//
// Esta es la parte MÁS crítica del negocio: si algo aquí se rompe,
// se le cobra o se le paga mal a un cliente real.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const { calcularConTasas } = require("../src/services/calculator");

// Tasas de ejemplo, iguales en forma a las que devuelve la tabla `rates`
const TASAS = {
    brl_0: 45, brl_100: 50, brl_500: 55, brl_1000: 60,
    usd1: 5.6, usd2: 5.5, mlc: 270
};

test("brl_cup: menos de 100 usa el tramo brl_0", () => {
    const r = calcularConTasas({ tipo: "brl_cup", valor: 50, tasas: TASAS });
    assert.equal(r.tasa, 45);
    assert.equal(r.cup, Math.floor(50 * 45));
});

test("brl_cup: exactamente 100 ya usa el tramo brl_100 (no brl_0)", () => {
    const r = calcularConTasas({ tipo: "brl_cup", valor: 100, tasas: TASAS });
    assert.equal(r.tasa, 50);
});

test("brl_cup: 499 sigue en el tramo brl_100", () => {
    const r = calcularConTasas({ tipo: "brl_cup", valor: 499, tasas: TASAS });
    assert.equal(r.tasa, 50);
});

test("brl_cup: exactamente 500 ya usa el tramo brl_500", () => {
    const r = calcularConTasas({ tipo: "brl_cup", valor: 500, tasas: TASAS });
    assert.equal(r.tasa, 55);
});

test("brl_cup: exactamente 1000 ya usa el tramo brl_1000 (el más alto)", () => {
    const r = calcularConTasas({ tipo: "brl_cup", valor: 1000, tasas: TASAS });
    assert.equal(r.tasa, 60);
});

test("brl_cup: monto muy alto (5000) sigue en brl_1000, no rompe", () => {
    const r = calcularConTasas({ tipo: "brl_cup", valor: 5000, tasas: TASAS });
    assert.equal(r.tasa, 60);
    assert.equal(r.cup, Math.floor(5000 * 60));
});

test("usd_clasica: usa la tasa usd1", () => {
    const r = calcularConTasas({ tipo: "usd_clasica", valor: 100, tasas: TASAS });
    assert.equal(r.tasa, 5.6);
    assert.equal(r.cup, Math.floor(100 * 5.6));
});

test("usd_prepago: usa la tasa usd2 (distinta a usd1)", () => {
    const r = calcularConTasas({ tipo: "usd_prepago", valor: 100, tasas: TASAS });
    assert.equal(r.tasa, 5.5);
});

test("usd_efectivo: usa usd1 y devuelve brl (no cup) — es lo que paga el cliente en Brasil", () => {
    const r = calcularConTasas({ tipo: "usd_efectivo", valor: 100, tasas: TASAS });
    assert.equal(r.tasa, 5.6);
    assert.equal(r.brl, Math.floor(100 * 5.6));
    assert.equal(r.cup, undefined);
});

test("mlc: usa la tasa mlc", () => {
    const r = calcularConTasas({ tipo: "mlc", valor: 50, tasas: TASAS });
    assert.equal(r.tasa, 270);
    assert.equal(r.cup, Math.floor(50 * 270));
});

test("mlc sin tasa configurada (null) -> no revienta, usa 0", () => {
    const r = calcularConTasas({ tipo: "mlc", valor: 50, tasas: { ...TASAS, mlc: null } });
    assert.equal(r.tasa, 0);
    assert.equal(r.cup, 0);
});

test("tipo desconocido -> null, no revienta", () => {
    assert.equal(calcularConTasas({ tipo: "tipo_que_no_existe", valor: 100, tasas: TASAS }), null);
});

test("sin tasas (DB caída) -> null, no revienta", () => {
    assert.equal(calcularConTasas({ tipo: "brl_cup", valor: 100, tasas: null }), null);
});

test("el resultado siempre es un número entero (Math.floor, nunca decimales de CUP)", () => {
    const r = calcularConTasas({ tipo: "brl_cup", valor: 33, tasas: TASAS }); // 33 * 45 = 1485, sin decimales igual
    assert.equal(Number.isInteger(r.cup), true);
    const r2 = calcularConTasas({ tipo: "usd_clasica", valor: 37, tasas: TASAS }); // 37 * 5.6 = 207.2 -> debe truncar
    assert.equal(r2.cup, 207);
});

// ── Programa VIP: bono de tasa por nivel (⭐/⭐⭐/⭐⭐⭐) ──

test("brl_cup: nivel 1 recibe el bono de nivel 1", () => {
    const t = { ...TASAS, bono_vip_1: 1, bono_vip_2: 2, bono_vip_3: 3 };
    const r = calcularConTasas({ tipo: "brl_cup", valor: 50, tasas: t, nivelVip: 1 });
    assert.equal(r.tasa, 45 + 1);
});

test("brl_cup: nivel 2 recibe más bono que nivel 1", () => {
    const t = { ...TASAS, bono_vip_1: 1, bono_vip_2: 2, bono_vip_3: 3 };
    const r = calcularConTasas({ tipo: "brl_cup", valor: 50, tasas: t, nivelVip: 2 });
    assert.equal(r.tasa, 45 + 2);
});

test("brl_cup: nivel 3 recibe el mayor bono de todos", () => {
    const t = { ...TASAS, bono_vip_1: 1, bono_vip_2: 2, bono_vip_3: 3 };
    const r = calcularConTasas({ tipo: "brl_cup", valor: 50, tasas: t, nivelVip: 3 });
    assert.equal(r.tasa, 45 + 3);
});

test("brl_cup: nivel 0 (no VIP) no recibe ningún bono", () => {
    const t = { ...TASAS, bono_vip_1: 1, bono_vip_2: 2, bono_vip_3: 3 };
    const r = calcularConTasas({ tipo: "brl_cup", valor: 50, tasas: t, nivelVip: 0 });
    assert.equal(r.tasa, 45);
});

test("brl_cup: sin nivelVip (undefined) -> se trata como nivel 0, no revienta", () => {
    const r = calcularConTasas({ tipo: "brl_cup", valor: 50, tasas: TASAS });
    assert.equal(r.tasa, 45);
});

test("usd_clasica: el bono VIP no aplica a USD en ningún nivel", () => {
    const t = { ...TASAS, bono_vip_1: 1, bono_vip_2: 2, bono_vip_3: 3 };
    const r = calcularConTasas({ tipo: "usd_clasica", valor: 100, tasas: t, nivelVip: 3 });
    assert.equal(r.tasa, 5.6);
});
