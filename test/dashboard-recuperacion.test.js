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
        setAttribute() {}, addEventListener() {}, appendChild() {}, querySelectorAll: () => []
    };
}

function cargarDashboardSandbox(fetchImpl) {
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
        fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ([]) })),
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

test("renderRecuperacion: las únicas acciones por fila son 'Ver mensaje' y 'Ver historial' -- ningún botón de enviar/contactar/campaña", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.renderRecuperacion([CANDIDATO_ALTA, CANDIDATO_MEDIA_VIEJO]);
    const html = sandbox.document.getElementById("tablaRecuperacion").innerHTML;
    const botones = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1].trim());
    assert.ok(botones.length > 0, "debe existir al menos un botón de acción");
    for (const texto of botones) {
        assert.match(texto, /Ver historial|Ver mensaje/);
        assert.doesNotMatch(texto, /^Enviar|[Ee]nviar mensaje/);
        assert.doesNotMatch(texto, /[Cc]ontactar/);
        assert.doesNotMatch(texto, /[Cc]ampaña/);
        assert.doesNotMatch(texto, /[Rr]ecuperar cliente/);
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

// ── 👀 Ver mensaje / 🔄 Otra variante (FASE 2 -- solo preview) ──

test("recuperacionVerMensaje: pide el preview al endpoint correcto y muestra el mensaje + metadatos discretos", async () => {
    let urlPedida = null;
    const sandbox = cargarDashboardSandbox(async (url) => {
        urlPedida = url;
        return { ok: true, status: 200, json: async () => ({ phone: "5511900030001", mensaje: "Lourdes 😊 ¿seguimos con aquellos MLC?", familia: "me_acorde", indice: 2, servicio: "MLC", antiguedadTono: "1-3d" }) };
    });
    await sandbox.recuperacionVerMensaje("5511900030001");
    assert.match(String(urlPedida), /^\/admin\/recuperacion\/mensaje\?phone=5511900030001$/);
    assert.equal(sandbox.document.getElementById("modalRecuperacionMensaje").style.display, "flex");
    assert.equal(sandbox.document.getElementById("recMensajeTexto").innerText, "Lourdes 😊 ¿seguimos con aquellos MLC?");
    const meta = sandbox.document.getElementById("recMensajeMeta").innerText;
    assert.match(meta, /me_acorde/);
    assert.match(meta, /MLC/);
    assert.match(meta, /1-3d/);
});

test("recuperacionOtraVariante: vuelve a pedir el preview excluyendo la familia/índice ya mostrados", async () => {
    const llamadas = [];
    const sandbox = cargarDashboardSandbox(async (url) => {
        llamadas.push(String(url));
        return { ok: true, status: 200, json: async () => ({ phone: "5511900030001", mensaje: "Otra variante distinta", familia: "broma", indice: 1, servicio: "MLC", antiguedadTono: "1-3d" }) };
    });
    await sandbox.recuperacionVerMensaje("5511900030001");
    await sandbox.recuperacionOtraVariante();
    assert.equal(llamadas.length, 2);
    assert.doesNotMatch(llamadas[0], /excluir/);
    assert.match(llamadas[1], /excluirFamilia=broma&excluirIndice=1|excluirFamilia=me_acorde/); // excluye lo que quedó guardado tras la primera llamada
});

test("recuperacionVerMensaje: si el backend dice que ya no es candidato (404), avisa y cierra el modal sin mostrar nada inventado", async () => {
    const sandbox = cargarDashboardSandbox(async () => ({ ok: false, status: 404, json: async () => ({ error: "Ese cliente ya no es un candidato recuperable." }) }));
    await sandbox.recuperacionVerMensaje("5511900030001");
    assert.equal(sandbox.document.getElementById("modalRecuperacionMensaje").style.display, "none");
    assert.match(sandbox.window._ultimoAlert, /ya no es un candidato recuperable/);
});

test("recuperacionCerrarMensaje: oculta el modal y limpia el estado guardado", async () => {
    const sandbox = cargarDashboardSandbox(async () => ({ ok: true, status: 200, json: async () => ({ phone: "5511900030001", mensaje: "x", familia: "broma", indice: 0, servicio: "MLC", antiguedadTono: "1-3d" }) }));
    await sandbox.recuperacionVerMensaje("5511900030001");
    sandbox.recuperacionCerrarMensaje();
    assert.equal(sandbox.document.getElementById("modalRecuperacionMensaje").style.display, "none");
    assert.equal(sandbox.window._recuperacionPreviewActual, null);
});

test("el preview NUNCA dispara un fetch a un endpoint de envío de WhatsApp", async () => {
    const urls = [];
    const sandbox = cargarDashboardSandbox(async (url) => {
        urls.push(String(url));
        return { ok: true, status: 200, json: async () => ({ phone: "5511900030001", mensaje: "x", familia: "broma", indice: 0, servicio: "MLC", antiguedadTono: "1-3d" }) };
    });
    await sandbox.recuperacionVerMensaje("5511900030001");
    await sandbox.recuperacionOtraVariante();
    for (const u of urls) assert.doesNotMatch(u, /enviar|mensaje\/enviar|whatsapp\/send/i);
});
