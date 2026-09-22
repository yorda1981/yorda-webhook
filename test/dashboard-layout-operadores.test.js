"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — reorganización visual del dashboard (sección G),
// Programa VIP desplegable (sección H) y CRUD de Operadores de
// Transferencias (secciones B/C) en public/dashboard.html.
//
// Carga el <script> real en un sandbox de Node (vm) -- mismo patrón que
// test/dashboard-recargas-separation.test.js y
// test/dashboard-bloqueados-compacto.test.js.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const DASHBOARD_PATH = path.join(__dirname, "..", "public", "dashboard.html");

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
        addEventListener(evt, fn) { this._listeners = this._listeners || {}; this._listeners[evt] = fn; },
        click() { if (this._listeners?.click) this._listeners.click(); },
        appendChild() {},
        querySelectorAll: () => []
    };
}

function cargarDashboardSandbox(fetchImpl, { token } = {}) {
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
    // querySelectorAll(".op-modalidad") y ".op-modalidad:checked" se usan en
    // guardarOperador() -- se simulan con un registro propio de checkboxes
    // creados vía getElementById (el form de Operadores usa clase, no ids
    // individuales para cada checkbox de modalidad).
    const modalidadCheckboxes = [];
    const documentStub = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, makeElement(id));
            return elements.get(id);
        },
        querySelectorAll(selector) {
            if (selector === ".op-modalidad") return modalidadCheckboxes;
            if (selector === ".op-modalidad:checked") return modalidadCheckboxes.filter(cb => cb.checked);
            return [];
        },
        addEventListener() {},
        createElement: () => makeElement("tmp")
    };

    const sandboxStorage = {};
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
        sessionStorage: {
            getItem: k => (k in sandboxStorage ? sandboxStorage[k] : null),
            setItem: (k, v) => { sandboxStorage[k] = v; },
            removeItem: k => { delete sandboxStorage[k]; }
        },
        Intl, Date, JSON
    };
    vm.createContext(sandbox);
    new vm.Script(codigo, { filename: "dashboard.html<script>" }).runInContext(sandbox);

    // Simula los 4 checkboxes reales de modalidad (cup/usd/mlc/todos) para
    // que guardarOperador()/editarOperadorForm() los encuentren.
    for (const valor of ["cup", "usd", "mlc", "todos"]) {
        const cb = makeElement("op-modalidad-" + valor);
        cb.value = valor;
        cb.checked = false;
        modalidadCheckboxes.push(cb);
    }

    return sandbox;
}

// ── El nuevo layout no rompe secciones existentes ──

test("layout nuevo: todas las secciones preexistentes siguen presentes en el HTML (ids intactos)", () => {
    const html = fs.readFileSync(DASHBOARD_PATH, "utf8");
    const idsQueDebenSeguirExistiendo = [
        "tablaPendientes", "countPendientes", "tablaEnProceso", "countEnProceso",
        "tablaRecargasOps", "countRecargasOps", "tablaBloqueados", "countBloqueados",
        "tablaEntregas", "seccionTasas", "btnSave",
        "stat-clientes", "stat-ops", "stat-vol", "stat-pend", "stat-completadas",
        "stat-cotizados", "stat-cierres", "stat-conversion", "stat-abandonos"
    ];
    for (const id of idsQueDebenSeguirExistiendo) {
        assert.match(html, new RegExp(`id="${id}"`), `falta el id="${id}" -- una sección existente se rompió`);
    }
});

test("Resumen General conserva las 9 métricas y usa etiquetas honestas", () => {
    const html = fs.readFileSync(DASHBOARD_PATH, "utf8");
    const metricas = [
        "stat-clientes", "stat-ops", "stat-vol", "stat-pend", "stat-completadas",
        "stat-cotizados", "stat-cierres", "stat-conversion", "stat-abandonos"
    ];
    for (const id of metricas) assert.match(html, new RegExp(`id="${id}"`));
    for (const etiqueta of [
        "Contactos registrados", "Pago confirmado", "Volumen confirmado",
        "Pendientes de confirmación", "Clientes cotizados hoy", "Cierres Hoy",
        "Conversión hoy", "En abandono \\(30 días\\)"
    ]) assert.match(html, new RegExp(etiqueta));
    assert.match(html, /Resumen financiero y comercial de Yorda Envíos/);
});

// ── VIP abre/cierra ──

test("VIP: arranca colapsado por defecto (sin sesión previa) y togglea al hacer click en el header", () => {
    const sandbox = cargarDashboardSandbox();
    const body = sandbox.document.getElementById("bodyVip");
    const chev = sandbox.document.getElementById("chevVip");
    assert.equal(body.classList.contains("abierto"), false, "cerrado por defecto");

    sandbox.document.getElementById("hdrVip").click();
    assert.equal(body.classList.contains("abierto"), true, "un click lo abre");
    assert.equal(chev.classList.contains("abierto"), true);

    sandbox.document.getElementById("hdrVip").click();
    assert.equal(body.classList.contains("abierto"), false, "un segundo click lo vuelve a cerrar");
});

test("VIP: el estado abierto/cerrado se recuerda en sessionStorage durante la sesión", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.document.getElementById("hdrVip").click(); // abre
    assert.equal(sandbox.sessionStorage.getItem("vipAbierto"), "1");
    sandbox.document.getElementById("hdrVip").click(); // cierra
    assert.equal(sandbox.sessionStorage.getItem("vipAbierto"), "0");
});

test("VIP: la configuración real (niveles/umbrales/bonos) sigue exactamente igual dentro del panel colapsable", () => {
    const html = fs.readFileSync(DASHBOARD_PATH, "utf8");
    for (const id of ["umbral_vip_1", "bono_vip_1", "descuento_entrega_1", "umbral_vip_2", "umbral_vip_3"]) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
});

// ── Responsive básico ──

test("responsive: .layout-superior colapsa a una columna en pantallas <= 900px", () => {
    const html = fs.readFileSync(DASHBOARD_PATH, "utf8");
    assert.match(html, /@media\s*\(max-width:\s*900px\)\s*\{\s*\.layout-superior\s*\{\s*grid-template-columns:\s*1fr;/);
});

test("responsive: .layout-superior tiene 2 columnas en pantallas normales", () => {
    const html = fs.readFileSync(DASHBOARD_PATH, "utf8");
    assert.match(html, /\.layout-superior\s*\{[^}]*grid-template-columns:\s*2fr 1fr/);
});

// ── Operadores de Transferencias: CRUD desde el dashboard ──

test("cargarOperadores/renderOperadores: pinta nombre, teléfono, modalidades y estado", async () => {
    const sandbox = cargarDashboardSandbox(async (url) => {
        if (String(url).includes("/admin/operadores")) {
            return { ok: true, status: 200, json: async () => ([
                { id: 1, nombre: "Juan Pérez", telefono: "5511900001", activo: true, modalidades: ["cup", "usd"] },
                { id: 2, nombre: "Pedro", telefono: "5511900002", activo: false, modalidades: ["todos"] }
            ]) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    }, { token: "fake-token" });

    await sandbox.cargarOperadores();
    const tbody = sandbox.document.getElementById("tablaOperadores");
    assert.match(tbody.innerHTML, /Juan Pérez/);
    assert.match(tbody.innerHTML, /CUP, USD/);
    assert.match(tbody.innerHTML, /● ACTIVO/);
    assert.match(tbody.innerHTML, /○ INACTIVO/);
    assert.equal(sandbox.document.getElementById("countOperadores").innerText, 2);
});

test("guardarOperador: crea uno nuevo con los datos del formulario (modo Agregar)", async () => {
    let cuerpoEnviado = null;
    const sandbox = cargarDashboardSandbox(async (url, opts) => {
        if (opts && opts.method === "POST" && String(url) === "/admin/operadores") {
            cuerpoEnviado = JSON.parse(opts.body);
            return { ok: true, status: 200, json: async () => ({ success: true, operador: { id: 3, ...cuerpoEnviado } }) };
        }
        return { ok: true, status: 200, json: async () => ([]) };
    }, { token: "fake-token" });

    sandbox.document.getElementById("op_nombre").value = "Carlos";
    sandbox.document.getElementById("op_telefono").value = "5511900003";
    sandbox.document.querySelectorAll(".op-modalidad").find(cb => cb.value === "mlc").checked = true;

    await sandbox.guardarOperador();

    assert.ok(cuerpoEnviado, "debe haber llamado a POST /admin/operadores");
    assert.equal(cuerpoEnviado.nombre, "Carlos");
    assert.deepEqual(cuerpoEnviado.modalidades, ["mlc"]);
});

test("guardarOperador: sin ninguna modalidad marcada -> no llama al backend", async () => {
    let llamado = false;
    const sandbox = cargarDashboardSandbox(async () => { llamado = true; return { ok: true, status: 200, json: async () => ({}) }; }, { token: "fake-token" });
    sandbox.document.getElementById("op_nombre").value = "Sin Modalidad";
    sandbox.document.getElementById("op_telefono").value = "5511900004";
    await sandbox.guardarOperador();
    assert.equal(llamado, false, "no debe mandar el request si no hay modalidad seleccionada");
});

test("toggleActivoOperador: llama al endpoint correcto y recarga la lista", async () => {
    const llamadas = [];
    const sandbox = cargarDashboardSandbox(async (url, opts) => {
        llamadas.push({ url: String(url), opts });
        if (String(url).includes("/activo")) return { ok: true, status: 200, json: async () => ({ success: true }) };
        return { ok: true, status: 200, json: async () => ([]) };
    }, { token: "fake-token" });

    await sandbox.toggleActivoOperador(7, false);
    const llamadaActivo = llamadas.find(l => l.url.includes("/activo"));
    assert.ok(llamadaActivo);
    assert.equal(llamadaActivo.url, "/admin/operadores/7/activo");
    assert.deepEqual(JSON.parse(llamadaActivo.opts.body), { activo: false });
});

// ── Entregas: control ON/OFF de avisos automáticos individual (sección L) ──

test("renderTablaEntregas: una entrega PENDIENTE con avisos_automaticos=true muestra el botón 'Avisos ON'", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.renderTablaEntregas([{
        id: 1, codigo: "E-1001", created_at: new Date().toISOString(), cliente_nombre: "Ana",
        cantidad: 100, moneda: "CUP", estado_entrega: "PENDIENTE", estado_pago: "NO_APLICA",
        avisos_automaticos: true
    }]);
    const tbody = sandbox.document.getElementById("tablaEntregas");
    assert.match(tbody.innerHTML, /🔔 Avisos ON/);
    assert.match(tbody.innerHTML, /entregaToggleAvisos\(1, false\)/);
});

test("renderTablaEntregas: una entrega PENDIENTE con avisos_automaticos=false muestra 'Avisos OFF'", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.renderTablaEntregas([{
        id: 2, codigo: "E-1002", created_at: new Date().toISOString(), cliente_nombre: "Ana",
        cantidad: 100, moneda: "CUP", estado_entrega: "PENDIENTE", estado_pago: "NO_APLICA",
        avisos_automaticos: false
    }]);
    const tbody = sandbox.document.getElementById("tablaEntregas");
    assert.match(tbody.innerHTML, /🔕 Avisos OFF/);
    assert.match(tbody.innerHTML, /entregaToggleAvisos\(2, true\)/);
});

test("renderTablaEntregas: una entrega ya ENTREGADO no muestra el control de avisos (ya no aplica)", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.renderTablaEntregas([{
        id: 3, codigo: "E-1003", created_at: new Date().toISOString(), cliente_nombre: "Ana",
        cantidad: 100, moneda: "CUP", estado_entrega: "ENTREGADO", estado_pago: "PENDIENTE_DE_PAGO",
        avisos_automaticos: true
    }]);
    const tbody = sandbox.document.getElementById("tablaEntregas");
    assert.doesNotMatch(tbody.innerHTML, /Avisos ON|Avisos OFF/);
});

test("entregaToggleAvisos: llama al endpoint correcto con el nuevo valor", async () => {
    const llamadas = [];
    const sandbox = cargarDashboardSandbox(async (url, opts) => {
        llamadas.push({ url: String(url), opts });
        return { ok: true, status: 200, json: async () => ({ success: true }) };
    }, { token: "fake-token" });

    await sandbox.entregaToggleAvisos(5, false);
    const llamada = llamadas.find(l => l.url.includes("/avisos"));
    assert.ok(llamada);
    assert.equal(llamada.url, "/admin/entregas/5/avisos");
    assert.deepEqual(JSON.parse(llamada.opts.body), { activo: false });
});
