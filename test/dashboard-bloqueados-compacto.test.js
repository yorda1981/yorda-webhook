"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — resumen compacto de "Números Bloqueados" en el
// dashboard (public/dashboard.html). Mejora solo visual/UX: no toca
// src/services/blocked-numbers.js, ninguna regla de automatización, ni
// historial/operaciones -- ver test/blocked-numbers.test.js para la lógica
// de backend, que no cambió.
//
// Carga el <script> real de dashboard.html en un sandbox de Node (vm), con
// un DOM mínimo simulado, y ejecuta las funciones TAL COMO están escritas
// -- no una reimplementación paralela de la lógica.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
        addEventListener() {},
        appendChild() {},
        querySelectorAll: () => []
    };
}

// `fetchImpl` es sobreescribible por test -- por defecto no se usa (los
// tests de renderBloqueados() llaman la función directamente), pero
// bloquearNumero()/desbloquearNumero()/cargarBloqueados() sí pasan por
// fetch real.
//
// `token` es una variable de módulo (`let token = "";`) privada del
// <script>, no una propiedad de `window` -- en un Script de vm, un `let`
// de nivel superior NO queda expuesto como propiedad del objeto de
// contexto (verificado: `sandbox.token` da `undefined` aunque el script
// lo reasigne). Para las pruebas que necesitan pasar el guard `if
// (!token) return;` de cargarBloqueados() sin arrastrar los efectos
// colaterales asíncronos de conectar() (que dispara refreshData(),
// cargarEntregas(), cargarTasaUsdt() sin esperarlas y podría pisar el
// estado del test con datos de "priming"), se sustituye el valor inicial
// directamente en el código fuente antes de ejecutarlo -- determinista,
// sin condiciones de carrera.
function cargarDashboardSandbox(fetchImpl, { token } = {}) {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!m) throw new Error("No se encontró el bloque <script> en dashboard.html");
    let codigo = m[1];
    if (token) {
        const marcador = 'let token = "";';
        if (!codigo.includes(marcador)) throw new Error("No se encontró la declaración de `token` para primearla en el test");
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
        setInterval: () => 0,
        clearInterval: () => {},
        Intl,
        Date,
        JSON
    };
    vm.createContext(sandbox);
    new vm.Script(codigo, { filename: "dashboard.html<script>" }).runInContext(sandbox);
    return sandbox;
}

// bloquearNumero()/desbloquearNumero() disparan cargarBloqueados() sin
// esperarlo (fire-and-forget, igual que en el resto del dashboard) -- en un
// navegador real la tabla se actualiza unos milisegundos después sin que
// nadie lo note; en el test hay que dejar drenar la cola de microtasks
// pendiente antes de comprobar el DOM.
function flush() {
    return new Promise(resolve => setImmediate(resolve));
}

function bloqueado(i, extra = {}) {
    return {
        phone: `55119000000${String(i).padStart(2, "0")}`,
        motivo: `Motivo ${i}`,
        created_at: new Date(2026, 8, 21, 12, 0, i).toISOString(),
        ...extra
    };
}

// ── Casos base de renderBloqueados() ──

test("0 bloqueados: mensaje 'Sin números bloqueados', contador en 0, sin botón 'Ver todos'", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.renderBloqueados([]);
    const tbody = sandbox.document.getElementById("tablaBloqueados");
    assert.match(tbody.innerHTML, /Sin números bloqueados/);
    assert.equal(sandbox.document.getElementById("countBloqueados").innerText, 0);
    assert.equal(sandbox.document.getElementById("btnVerTodosBloqueados").style.display, "none");
});

test("1-5 bloqueados: se muestran todos normalmente, sin botón 'Ver todos'", () => {
    const sandbox = cargarDashboardSandbox();
    const lista = [1, 2, 3].map(i => bloqueado(i));
    sandbox.renderBloqueados(lista);
    const tbody = sandbox.document.getElementById("tablaBloqueados");
    const filas = (tbody.innerHTML.match(/<tr>/g) || []).length;
    assert.equal(filas, 3);
    assert.equal(sandbox.document.getElementById("countBloqueados").innerText, 3);
    assert.equal(sandbox.document.getElementById("btnVerTodosBloqueados").style.display, "none");
});

test("exactamente 5 bloqueados: se muestran los 5, sin botón 'Ver todos' (no hay nada más que ver)", () => {
    const sandbox = cargarDashboardSandbox();
    const lista = [1, 2, 3, 4, 5].map(i => bloqueado(i));
    sandbox.renderBloqueados(lista);
    const tbody = sandbox.document.getElementById("tablaBloqueados");
    const filas = (tbody.innerHTML.match(/<tr>/g) || []).length;
    assert.equal(filas, 5);
    assert.equal(sandbox.document.getElementById("btnVerTodosBloqueados").style.display, "none");
});

test("6+ bloqueados: inicialmente solo se muestran los 5 más recientes (primeros del array, ya ordenado por el backend)", () => {
    const sandbox = cargarDashboardSandbox();
    const lista = Array.from({ length: 18 }, (_, i) => bloqueado(i + 1));
    sandbox.renderBloqueados(lista);
    const tbody = sandbox.document.getElementById("tablaBloqueados");
    const filas = (tbody.innerHTML.match(/<tr>/g) || []).length;
    assert.equal(filas, 5, "no debe mostrar más de 5 inicialmente");
    assert.match(tbody.innerHTML, /5511900000001/);
    assert.match(tbody.innerHTML, /5511900000005/);
    assert.doesNotMatch(tbody.innerHTML, /5511900000006/, "el sexto no debe aparecer en el resumen compacto");
});

test("contador total correcto: siempre refleja el total real, no la cantidad visible", () => {
    const sandbox = cargarDashboardSandbox();
    const lista = Array.from({ length: 18 }, (_, i) => bloqueado(i + 1));
    sandbox.renderBloqueados(lista);
    assert.equal(sandbox.document.getElementById("countBloqueados").innerText, 18);
    const btn = sandbox.document.getElementById("btnVerTodosBloqueados");
    assert.match(btn.innerText, /Ver todos \(18\)/);
});

// ── Ver todos / Mostrar menos ──

test("'Ver todos' despliega los 18 completos", () => {
    const sandbox = cargarDashboardSandbox();
    const lista = Array.from({ length: 18 }, (_, i) => bloqueado(i + 1));
    sandbox.window._ultimosBloqueados = lista;
    sandbox.renderBloqueados(lista);

    sandbox.toggleVerTodosBloqueados();
    const tbody = sandbox.document.getElementById("tablaBloqueados");
    const filas = (tbody.innerHTML.match(/<tr>/g) || []).length;
    assert.equal(filas, 18);
    assert.match(tbody.innerHTML, /5511900000018/);
    const btn = sandbox.document.getElementById("btnVerTodosBloqueados");
    assert.match(btn.innerText, /Mostrar menos/);
});

test("'Mostrar menos' vuelve a mostrar solo 5", () => {
    const sandbox = cargarDashboardSandbox();
    const lista = Array.from({ length: 18 }, (_, i) => bloqueado(i + 1));
    sandbox.window._ultimosBloqueados = lista;
    sandbox.renderBloqueados(lista);

    sandbox.toggleVerTodosBloqueados(); // expande
    sandbox.toggleVerTodosBloqueados(); // colapsa de nuevo

    const tbody = sandbox.document.getElementById("tablaBloqueados");
    const filas = (tbody.innerHTML.match(/<tr>/g) || []).length;
    assert.equal(filas, 5);
    const btn = sandbox.document.getElementById("btnVerTodosBloqueados");
    assert.match(btn.innerText, /Ver todos \(18\)/);
});

// ── Bloquear/desbloquear actualiza lista + contador, vista coherente ──

test("desbloquearNumero(): tras el éxito, recarga la lista y el contador baja en 1", async () => {
    let llamadas = 0;
    const listaInicial = Array.from({ length: 7 }, (_, i) => bloqueado(i + 1));
    const listaTrasDesbloquear = listaInicial.filter(b => b.phone !== "5511900000003");

    const fetchImpl = async (url) => {
        llamadas++;
        if (String(url).includes("/desbloquear")) {
            return { ok: true, status: 200, json: async () => ({ success: true }) };
        }
        // GET /admin/bloqueados (llamado por cargarBloqueados tras desbloquear)
        return { ok: true, status: 200, json: async () => listaTrasDesbloquear };
    };

    const sandbox = cargarDashboardSandbox(fetchImpl, { token: "fake-token" });
    sandbox.window._ultimosBloqueados = listaInicial;
    sandbox.renderBloqueados(listaInicial);
    assert.equal(sandbox.document.getElementById("countBloqueados").innerText, 7);

    await sandbox.desbloquearNumero("5511900000003");
    await flush();

    assert.equal(sandbox.document.getElementById("countBloqueados").innerText, 6);
    const tbody = sandbox.document.getElementById("tablaBloqueados");
    assert.doesNotMatch(tbody.innerHTML, /5511900000003/, "el número desbloqueado ya no debe aparecer en la lista");
});

test("bloquearNumero(): tras el éxito, recarga la lista y el contador sube en 1, vista sigue coherente (compacta) con 6+ resultantes", async () => {
    const listaInicial = Array.from({ length: 5 }, (_, i) => bloqueado(i + 1));
    const listaTrasBloquear = [bloqueado(6), ...listaInicial];

    const fetchImpl = async (url, opts) => {
        if (opts && opts.method === "POST" && !String(url).includes("/desbloquear")) {
            return { ok: true, status: 200, json: async () => ({ success: true }) };
        }
        return { ok: true, status: 200, json: async () => listaTrasBloquear };
    };

    const sandbox = cargarDashboardSandbox(fetchImpl, { token: "fake-token" });
    sandbox.window._ultimosBloqueados = listaInicial;
    sandbox.renderBloqueados(listaInicial);
    assert.equal(sandbox.document.getElementById("countBloqueados").innerText, 5);
    assert.equal(sandbox.document.getElementById("btnVerTodosBloqueados").style.display, "none");

    sandbox.document.getElementById("bloq_telefono").value = "5511900000006";
    sandbox.document.getElementById("bloq_motivo").value = "Motivo 6";
    await sandbox.bloquearNumero();
    await flush();

    assert.equal(sandbox.document.getElementById("countBloqueados").innerText, 6);
    const tbody = sandbox.document.getElementById("tablaBloqueados");
    const filas = (tbody.innerHTML.match(/<tr>/g) || []).length;
    assert.equal(filas, 5, "con 6 resultantes, la vista compacta sigue mostrando solo 5 -- coherente con la regla de 6+");
    const btn = sandbox.document.getElementById("btnVerTodosBloqueados");
    assert.match(btn.innerText, /Ver todos \(6\)/);
});
