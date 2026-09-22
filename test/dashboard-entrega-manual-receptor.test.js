"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — formulario "Nueva entrega manual" del CRM de
// Entregas (public/dashboard.html): separación Cliente/Receptor y
// Provincia/Municipio como selectores dependientes reutilizando EXACTAMENTE
// el catálogo de la calculadora (public/provincias-cuba.js).
//
// Carga ambos archivos reales en un sandbox de Node (vm), en el mismo
// orden que el navegador (<script src="/provincias-cuba.js"> antes del
// <script> inline de dashboard.html) -- mismo patrón que
// test/dashboard-layout-operadores.test.js.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DASHBOARD_PATH = path.join(__dirname, "..", "public", "dashboard.html");
const PROVINCIAS_PATH = path.join(__dirname, "..", "public", "provincias-cuba.js");

function makeElement(id) {
    return {
        id,
        value: "",
        innerText: "",
        innerHTML: "",
        checked: false,
        disabled: false,
        style: {},
        classList: {
            _set: new Set(),
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
            contains(c) { return this._set.has(c); }
        },
        setAttribute() {},
        options: [], // simula <select>.options.length usado por poblarProvinciasManual()
        appendChild(opt) { this.options.push(opt); this.innerHTML += `<option value="${opt.value}">${opt.textContent}</option>`; },
        addEventListener() {},
        querySelectorAll: () => []
    };
}

function cargarDashboardSandbox(fetchImpl, { token } = {}) {
    const provinciasCodigo = fs.readFileSync(PROVINCIAS_PATH, "utf8");
    const html = fs.readFileSync(DASHBOARD_PATH, "utf8");
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!m) throw new Error("No se encontró el bloque <script> en dashboard.html");
    let codigo = m[1];
    if (token) {
        const marcador = 'let token = "";';
        if (!codigo.includes(marcador)) throw new Error("No se encontró la declaración de `token`");
        codigo = codigo.replace(marcador, `let token = ${JSON.stringify(token)};`);
    }

    const elements = new Map();
    const documentStub = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, makeElement(id));
            return elements.get(id);
        },
        querySelectorAll() { return []; },
        addEventListener() {},
        createElement: () => makeElement("tmp")
    };

    const sandbox = {
        document: documentStub,
        window: {},
        console,
        fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
        alert: () => {},
        confirm: () => true,
        prompt: () => null,
        setInterval: () => 0,
        clearInterval: () => {},
        sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        Intl, Date, JSON, URLSearchParams
    };
    vm.createContext(sandbox);
    // Mismo orden que el documento real: /provincias-cuba.js primero.
    new vm.Script(provinciasCodigo, { filename: "provincias-cuba.js" }).runInContext(sandbox);
    new vm.Script(codigo, { filename: "dashboard.html<script>" }).runInContext(sandbox);
    return sandbox;
}

test("public/dashboard.html carga /provincias-cuba.js -- el mismo catálogo que usa la calculadora, sin una segunda lista", () => {
    const html = fs.readFileSync(DASHBOARD_PATH, "utf8");
    assert.match(html, /<script src="\/provincias-cuba\.js"><\/script>/);
});

test("public/calculadora.html también carga /provincias-cuba.js -- catálogo compartido, no duplicado", () => {
    const calc = fs.readFileSync(path.join(__dirname, "..", "public", "calculadora.html"), "utf8");
    assert.match(calc, /<script src="\/provincias-cuba\.js"><\/script>/);
    assert.doesNotMatch(calc, /const PROVINCIAS = \[/, "calculadora.html no debe volver a definir el catálogo -- debe venir del archivo compartido");
});

test("poblarProvinciasManual: llena el select con las 16 provincias reales de Cuba, sin repetir si ya está poblado", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.poblarProvinciasManual();
    const sel = sandbox.document.getElementById("manProvincia");
    assert.equal(sel.options.length, 16);
    assert.ok(sel.options.some(o => o.value === "La Habana"));

    sandbox.poblarProvinciasManual(); // segunda llamada -- no debe duplicar
    assert.equal(sel.options.length, 16);
});

test("poblarMunicipiosManual: al elegir 'La Habana' muestra únicamente sus municipios reales", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.poblarProvinciasManual();
    sandbox.document.getElementById("manProvincia").value = "La Habana";
    sandbox.poblarMunicipiosManual();

    const selMun = sandbox.document.getElementById("manMunicipio");
    assert.equal(selMun.disabled, false);
    assert.match(selMun.innerHTML, /Playa/);
    assert.match(selMun.innerHTML, /Plaza de la Revolución/);
    assert.doesNotMatch(selMun.innerHTML, /Santa Clara/, "un municipio de otra provincia (Villa Clara) no debe aparecer");
});

test("poblarMunicipiosManual: cambiar a otra provincia reemplaza los municipios (no los acumula)", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.poblarProvinciasManual();
    sandbox.document.getElementById("manProvincia").value = "La Habana";
    sandbox.poblarMunicipiosManual();
    sandbox.document.getElementById("manProvincia").value = "Villa Clara";
    sandbox.poblarMunicipiosManual();

    const selMun = sandbox.document.getElementById("manMunicipio");
    assert.match(selMun.innerHTML, /Santa Clara/);
    assert.doesNotMatch(selMun.innerHTML, /Playa/, "los municipios de La Habana no deben quedar acumulados");
});

test("poblarMunicipiosManual: sin provincia elegida -- el select de municipio queda deshabilitado y vacío", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.poblarProvinciasManual();
    sandbox.document.getElementById("manProvincia").value = "";
    sandbox.poblarMunicipiosManual();

    const selMun = sandbox.document.getElementById("manMunicipio");
    assert.equal(selMun.disabled, true);
});

// ── crearEntregaManualForm: separación Cliente/Receptor ──

function llenarFormularioBase(sandbox) {
    sandbox.document.getElementById("manWhatsapp").value = "5511900000001";
    sandbox.document.getElementById("manNombre").value = "Cliente Paga";
    sandbox.document.getElementById("manMontoBRL").value = "100";
    sandbox.document.getElementById("manReceptorNombre").value = "Receptor Cuba";
    sandbox.document.getElementById("manCantidad").value = "9500";
    sandbox.document.getElementById("manMoneda").value = "CUP";
}

test("crearEntregaManualForm: manda receptorNombre (distinto de clienteNombre) en el payload", async () => {
    let cuerpoEnviado = null;
    const sandbox = cargarDashboardSandbox(async (url, opts) => {
        if (String(url) === "/admin/entregas/manual") {
            cuerpoEnviado = JSON.parse(opts.body);
            return { ok: true, status: 200, json: async () => ({ success: true, entrega: { codigo: "E-2000" } }) };
        }
        return { ok: true, status: 200, json: async () => ([]) };
    }, { token: "fake-token" });

    llenarFormularioBase(sandbox);
    await sandbox.crearEntregaManualForm();

    assert.ok(cuerpoEnviado, "debe haber llamado a POST /admin/entregas/manual");
    assert.equal(cuerpoEnviado.clienteNombre, "Cliente Paga");
    assert.equal(cuerpoEnviado.receptorNombre, "Receptor Cuba");
    assert.notEqual(cuerpoEnviado.clienteNombre, cuerpoEnviado.receptorNombre);
});

test("crearEntregaManualForm: sin receptorNombre -- no llama al backend (campo obligatorio)", async () => {
    let llamado = false;
    const sandbox = cargarDashboardSandbox(async () => { llamado = true; return { ok: true, status: 200, json: async () => ({}) }; }, { token: "fake-token" });

    sandbox.document.getElementById("manWhatsapp").value = "5511900000001";
    sandbox.document.getElementById("manNombre").value = "Cliente Paga";
    sandbox.document.getElementById("manMontoBRL").value = "100";
    sandbox.document.getElementById("manCantidad").value = "9500";
    // manReceptorNombre queda vacío a propósito

    await sandbox.crearEntregaManualForm();
    assert.equal(llamado, false, "no debe mandar el request si falta el nombre del receptor");
});

test("crearEntregaManualForm: al crear con éxito, limpia el campo de receptor y resetea el municipio", async () => {
    const sandbox = cargarDashboardSandbox(async (url) => {
        if (String(url) === "/admin/entregas/manual") return { ok: true, status: 200, json: async () => ({ success: true, entrega: { codigo: "E-2001" } }) };
        return { ok: true, status: 200, json: async () => ([]) };
    }, { token: "fake-token" });

    llenarFormularioBase(sandbox);
    sandbox.poblarProvinciasManual();
    sandbox.document.getElementById("manProvincia").value = "La Habana";
    sandbox.poblarMunicipiosManual();
    sandbox.document.getElementById("manMunicipio").value = "Playa";

    await sandbox.crearEntregaManualForm();

    assert.equal(sandbox.document.getElementById("manReceptorNombre").value, "");
    assert.equal(sandbox.document.getElementById("manMunicipio").disabled, true);
});
