"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — sección "🎯 Clientes por recuperar" del dashboard
// (public/dashboard.html), FASE 1: exclusivamente consulta/revisión.
//
// Carga el <script> real en un sandbox de Node (vm) -- mismo patrón que
// test/dashboard-monto-a-entregar.test.js -- y ejecuta renderRecuperacion()
// TAL COMO está escrita, nunca una reimplementación paralela.
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
        addEventListener() {}, appendChild() {}, querySelectorAll: () => []
    };
}

function cargarDashboardSandbox() {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    const codigo = m[1];

    const elements = new Map();
    const documentStub = {
        getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); },
        addEventListener() {},
        createElement: () => makeElement("tmp")
    };

    const sandbox = {
        document: documentStub, window: {}, console,
        fetch: async () => ({ ok: true, status: 200, json: async () => ([]) }),
        alert: (msg) => { sandbox.window._ultimoAlert = msg; },
        confirm: () => true, setInterval: () => 0, clearInterval: () => {},
        Intl, Date, JSON, Number
    };
    vm.createContext(sandbox);
    new vm.Script(codigo, { filename: "dashboard.html<script>" }).runInContext(sandbox);
    return sandbox;
}

const CANDIDATO_ALTA = {
    phone: "5511900030001", nombre: "Ana García", estado: "aguardando_comprovante",
    prioridad: "alta", servicio: "USD Clásica", tipoFavorito: "usd_clasica", ultimoMonto: 500,
    fechaIntento: new Date(Date.now() - 3 * 60 * 60000).toISOString(), antiguedad: "reciente",
    estadoCrm: "cotizado", ultimoRecordatorio: null, tipoUltimoRecordatorio: null
};
const CANDIDATO_MEDIA_VIEJO = {
    phone: "5511900030002", nombre: "Pedro López", estado: "cotizacion_realizada",
    prioridad: "media", servicio: "CUP transferencia", tipoFavorito: "brl_cup", ultimoMonto: 300,
    fechaIntento: new Date(Date.now() - 10 * 24 * 60 * 60000).toISOString(), antiguedad: "recuperacion",
    estadoCrm: "abandono", ultimoRecordatorio: new Date(Date.now() - 9 * 24 * 60 * 60000).toISOString(),
    tipoUltimoRecordatorio: "recuperar_24h"
};

test("public/dashboard.html contiene la sección '🎯 Clientes por recuperar'", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    assert.match(html, /🎯 Clientes por recuperar/);
});

test("cargarRecuperacion llama exactamente a GET /admin/recuperacion/candidatos (mismo endpoint que el backend expone)", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    assert.match(html, /fetch\("\/admin\/recuperacion\/candidatos"/);
});

test("renderRecuperacion: cuenta correctamente Total/Alta/Media/>7 días", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.renderRecuperacion([CANDIDATO_ALTA, CANDIDATO_MEDIA_VIEJO]);
    assert.equal(sandbox.document.getElementById("recTotal").innerText, 2);
    assert.equal(sandbox.document.getElementById("recTotalCard").innerText, 2);
    assert.equal(sandbox.document.getElementById("recAlta").innerText, 1);
    assert.equal(sandbox.document.getElementById("recMedia").innerText, 1);
    assert.equal(sandbox.document.getElementById("recMas7d").innerText, 1);
});

test("renderRecuperacion: sin candidatos -> contadores en 0 y mensaje vacío, nunca error", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.renderRecuperacion([]);
    assert.equal(sandbox.document.getElementById("recTotal").innerText, 0);
    assert.match(sandbox.document.getElementById("tablaRecuperacion").innerHTML, /Sin clientes por recuperar/);
});

test("renderRecuperacion: la fila muestra cliente, WhatsApp, prioridad, servicio, monto, antigüedad y estado del intento", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.renderRecuperacion([CANDIDATO_ALTA]);
    const html = sandbox.document.getElementById("tablaRecuperacion").innerHTML;
    assert.match(html, /Ana García/);
    assert.match(html, /5511900030001/);
    assert.match(html, /Alta/);
    assert.match(html, /USD Clásica/);
    assert.match(html, /R\$500/);
    assert.match(html, /Esperando comprobante/);
});

test("renderRecuperacion: la ÚNICA acción por fila es 'Ver historial' -- ningún botón de enviar/recuperar/contactar", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.renderRecuperacion([CANDIDATO_ALTA, CANDIDATO_MEDIA_VIEJO]);
    const html = sandbox.document.getElementById("tablaRecuperacion").innerHTML;
    const botones = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1].trim());
    assert.ok(botones.length > 0, "debe existir al menos el botón de historial");
    for (const texto of botones) {
        assert.match(texto, /Ver historial/);
        assert.doesNotMatch(texto, /[Ee]nviar/);
        assert.doesNotMatch(texto, /[Cc]ontactar/);
        assert.doesNotMatch(texto, /[Cc]ampaña/);
    }
});

test("recuperacionVerHistorial reutiliza window._ultimasOperaciones (sin fetch nuevo) y nunca escribe nada", async () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.window._ultimasOperaciones = [
        { id: 10, phone: "5511900030001", tipo: "usd_clasica", monto: 500, status: "completada", created_at: "2026-01-01T00:00:00.000Z" },
        { id: 11, phone: "5511900099999", tipo: "brl_cup", monto: 100, status: "completada", created_at: "2026-01-02T00:00:00.000Z" }
    ];
    sandbox.recuperacionVerHistorial("5511900030001");
    assert.match(sandbox.window._ultimoAlert, /#10/);
    assert.doesNotMatch(sandbox.window._ultimoAlert, /#11/);
});

test("recuperacionVerHistorial: cliente sin operaciones -> avisa sin datos, nunca inventa un historial", async () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.window._ultimasOperaciones = [];
    sandbox.recuperacionVerHistorial("5511900030001");
    assert.match(sandbox.window._ultimoAlert, /Sin operaciones/);
});
