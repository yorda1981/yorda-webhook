"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — columna "A ENTREGAR" en Pendientes / En Proceso de
// Entrega (public/dashboard.html) y el campo que la alimenta
// (src/services/operations.js:obtenerTodas).
//
// Problema real: operations.monto es lo pagado en BRL, y operations.cup se
// guarda en 0 para usd_efectivo (ver pedido-web-flow.js) -- así que NINGUNO
// de los dos sirve como "cantidad real a entregar" para USD. El valor
// confiable para ambas monedas es entregas.cantidad/entregas.moneda (mismos
// datos ya almacenados al crear la entrega, nunca recalculados).
//
// Se prueban las funciones reales del <script> de dashboard.html (vm sandbox,
// mismo patrón que test/dashboard-recargas-separation.test.js) -- nunca una
// reimplementación paralela.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeElement(id) {
    return {
        id, value: "", innerText: "", innerHTML: "", checked: false, disabled: false, style: {},
        classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, toggle() {}, contains() { return false; } },
        setAttribute() {}, addEventListener() {}, appendChild() {}, querySelectorAll: () => []
    };
}

function cargarDashboardSandbox() {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    const codigo = m[1];

    const elements = new Map();
    const documentStub = {
        getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); },
        querySelectorAll() { return []; },
        addEventListener() {},
        createElement: () => makeElement("tmp")
    };

    const sandbox = {
        document: documentStub, window: {}, console,
        fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
        alert: () => {}, confirm: () => true, setInterval: () => 0, clearInterval: () => {},
        Intl, Date, JSON, Number
    };
    vm.createContext(sandbox);
    new vm.Script(codigo, { filename: "dashboard.html<script>" }).runInContext(sandbox);
    return sandbox;
}

// ── esOperacionDeEntrega / etiquetaTipoEntrega ──

test("esOperacionDeEntrega: distingue cup_efectivo/usd_efectivo de transferencias y recargas", () => {
    const sandbox = cargarDashboardSandbox();
    assert.equal(sandbox.esOperacionDeEntrega({ tipo: "cup_efectivo" }), true);
    assert.equal(sandbox.esOperacionDeEntrega({ tipo: "usd_efectivo" }), true);
    assert.equal(sandbox.esOperacionDeEntrega({ tipo: "brl_cup" }), false);
    assert.equal(sandbox.esOperacionDeEntrega({ tipo: "recarga_nacional" }), false);
});

test("etiquetaTipoEntrega: presentación visual CUP efectivo / USD efectivo, sin tocar el valor interno de tipo", () => {
    const sandbox = cargarDashboardSandbox();
    assert.equal(sandbox.etiquetaTipoEntrega("cup_efectivo"), "CUP efectivo");
    assert.equal(sandbox.etiquetaTipoEntrega("usd_efectivo"), "USD efectivo");
    // Cualquier otro tipo (transferencia, recarga) se devuelve tal cual -- esta
    // función solo re-etiqueta Entregas, nunca inventa texto para otros tipos.
    assert.equal(sandbox.etiquetaTipoEntrega("brl_cup"), "brl_cup");
});

// ── montoAEntregarHtml ──

test("entrega CUP: muestra la cantidad real en CUP, nunca el monto pagado en BRL", () => {
    const sandbox = cargarDashboardSandbox();
    const op = { tipo: "cup_efectivo", monto: 720, entrega_cantidad: "80500", entrega_moneda: "CUP" };
    const html = sandbox.montoAEntregarHtml(op);
    assert.match(html, /80\.500 CUP/);
    assert.doesNotMatch(html, /720/, "el monto pagado en BRL no debe aparecer en esta columna");
    assert.doesNotMatch(html, /R\$/);
});

test("entrega USD: muestra la cantidad real en USD, nunca el monto pagado en BRL", () => {
    const sandbox = cargarDashboardSandbox();
    // Caso real de producción (E-1002): R$300 pagados, 50 USD a entregar --
    // operations.cup queda en 0 para USD, por eso se usa entrega_cantidad.
    const op = { tipo: "usd_efectivo", monto: 300, cup: 0, entrega_cantidad: "50", entrega_moneda: "USD" };
    const html = sandbox.montoAEntregarHtml(op);
    assert.match(html, /50 USD/);
    assert.doesNotMatch(html, /300/);
    assert.doesNotMatch(html, /R\$/);
});

test("formato de miles en CUP: separador de miles, sin decimales innecesarios (ej. 20.130 CUP)", () => {
    const sandbox = cargarDashboardSandbox();
    const html = sandbox.montoAEntregarHtml({ tipo: "cup_efectivo", entrega_cantidad: "20130", entrega_moneda: "CUP" });
    assert.match(html, /20\.130 CUP/);
});

test("USD entero: sin decimales de más (50 USD, no 50,00 USD)", () => {
    const sandbox = cargarDashboardSandbox();
    const html = sandbox.montoAEntregarHtml({ tipo: "usd_efectivo", entrega_cantidad: "50", entrega_moneda: "USD" });
    assert.match(html, /(?<!,\d\d )\b50 USD/);
    assert.doesNotMatch(html, /50,00/);
});

test("USD con centavos reales: muestra los 2 decimales (50,50 USD)", () => {
    const sandbox = cargarDashboardSandbox();
    const html = sandbox.montoAEntregarHtml({ tipo: "usd_efectivo", entrega_cantidad: "50.5", entrega_moneda: "USD" });
    assert.match(html, /50,50 USD/);
});

test("sin entrega_cantidad (compatibilidad hacia atrás) -- cae a operations.cup, nunca se rompe", () => {
    const sandbox = cargarDashboardSandbox();
    const html = sandbox.montoAEntregarHtml({ tipo: "cup_efectivo", cup: 95000 });
    assert.match(html, /95\.000 CUP/);
});

test("montoAEntregarHtml no muta el objeto de la operación (no altera datos)", () => {
    const sandbox = cargarDashboardSandbox();
    const op = { tipo: "usd_efectivo", monto: 300, entrega_cantidad: "50", entrega_moneda: "USD" };
    const copia = JSON.parse(JSON.stringify(op));
    sandbox.montoAEntregarHtml(op);
    assert.deepEqual(op, copia);
});

// ── Encabezados de columna ──

test("Pendientes y En Proceso de Entrega: el encabezado de la columna es 'A ENTREGAR'", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    const matches = html.match(/<th>A ENTREGAR<\/th>/g) || [];
    assert.equal(matches.length, 2, "debe aparecer en ambas tablas: Pendientes y En Proceso de Entrega");
    assert.doesNotMatch(html, /<th>Monto<\/th>/, "el encabezado anterior 'Monto' ya no debe quedar en ninguna de las dos tablas");
});
