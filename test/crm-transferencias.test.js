"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — CRM de Transferencias del dashboard.
// Reutiliza las operaciones reales de /admin/operaciones: el backend agrega
// `transferencia` (operadores.montosTransferencia, mismo mapeo que el aviso
// al operador) y public/dashboard.html solo lo pinta. Sandbox vm con el
// <script> real -- mismo patrón que test/dashboard-layout-operadores.test.js.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { montosTransferencia, datosMontoOperador } = require("../src/services/operadores");

const DASHBOARD_PATH = path.join(__dirname, "..", "public", "dashboard.html");

test("montosTransferencia: respeta las columnas invertidas de usd_clasica/mlc y excluye entregas/recargas", () => {
    assert.deepEqual(montosTransferencia({ tipo: "brl_cup", monto: 100, cup: 12000 }), { moneda: "CUP", brl: 100, destino: 12000 });
    assert.deepEqual(montosTransferencia({ tipo: "cup_transferencia", monto: "650", cup: "71400" }), { moneda: "CUP", brl: 650, destino: 71400 });
    assert.deepEqual(montosTransferencia({ tipo: "usd_clasica", monto: 100, cup: 560 }), { moneda: "USD", brl: 560, destino: 100 });
    assert.deepEqual(montosTransferencia({ tipo: "mlc", monto: 50, cup: 260 }), { moneda: "MLC", brl: 260, destino: 50 });
    assert.deepEqual(montosTransferencia({ tipo: "usd_transferencia", monto: 672, cup: 120 }), { moneda: "USD", brl: 672, destino: 120 });
    assert.deepEqual(montosTransferencia({ tipo: "mlc_transferencia", monto: 260, cup: 0 }), { moneda: "MLC", brl: 260, destino: null });
    for (const tipo of ["cup_efectivo", "usd_efectivo", "recarga_nacional", undefined]) assert.equal(montosTransferencia({ tipo, monto: 1, cup: 1 }), null);
});

test("datosMontoOperador conserva exactamente el formato anterior (refactor sin cambio de comportamiento)", () => {
    assert.deepEqual(datosMontoOperador({ tipo: "usd_clasica", monto: 100, cup: 560 }), { pagado: "R$560", destino: "100 USD" });
    assert.deepEqual(datosMontoOperador({ tipo: "mlc_transferencia", monto: 260, cup: 0 }), { pagado: "R$260", destino: null });
    assert.equal(datosMontoOperador({ tipo: "cup_efectivo", monto: 1, cup: 1 }), null);
});

function sandboxDashboard() {
    const html = fs.readFileSync(DASHBOARD_PATH, "utf8");
    const codigo = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const elements = new Map();
    const el = (id) => {
        if (!elements.has(id)) elements.set(id, { id, value: "", innerText: "", innerHTML: "", style: {}, addEventListener() {}, appendChild() {}, insertBefore() {}, querySelector: () => null, querySelectorAll: () => [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {} });
        return elements.get(id);
    };
    const sandbox = {
        document: { getElementById: el, querySelectorAll: () => [], addEventListener() {}, createElement: () => el("tmp") },
        window: {}, console, fetch: async () => ({ ok: true, json: async () => ({}) }),
        alert() {}, confirm: () => true, setInterval: () => 0, clearInterval() {},
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, Intl, Date, JSON
    };
    vm.createContext(sandbox);
    new vm.Script(codigo).runInContext(sandbox);
    return { sandbox, el };
}

const OPS = [
    { id: 1001, created_at: "2026-09-23T22:58:00Z", nombre: "Ana <b>", phone: "5511987654321", tarjeta: "9225129912345678", tipo: "usd_transferencia", status: "pendiente", origen: "dashboard_manual", transferencia: { moneda: "USD", brl: 672, destino: 120 } },
    { id: 900, created_at: "2026-09-22T10:00:00Z", nombre: "Luis", phone: "5511911112222", tarjeta: "9205111122223333", tipo: "brl_cup", status: "confirmada", origen: null, transferencia: { moneda: "CUP", brl: 100, destino: 12000 } },
    { id: 800, created_at: "2026-09-21T10:00:00Z", nombre: "Eva", phone: "5511933334444", tarjeta: "", tipo: "cup_efectivo", status: "pendiente", transferencia: null },
    { id: 700, created_at: "2026-09-20T10:00:00Z", nombre: "Rita", phone: "5511955556666", tarjeta: "9205", tipo: "mlc", status: "completada", transferencia: { moneda: "MLC", brl: 260, destino: 50 } }
];

test("CRM: lista WhatsApp + Dashboard manual, excluye entregas, y usa las acciones existentes", () => {
    const { sandbox, el } = sandboxDashboard();
    sandbox.window._ultimasOperaciones = OPS;
    sandbox.renderCrmTransferencias();
    const html = el("tablaCrmTransferencias").innerHTML;
    assert.equal(el("countCrmTransferencias").innerText, 3);
    assert.match(html, /#1001/); assert.match(html, /#900/); assert.match(html, /#700/);
    assert.doesNotMatch(html, /#800/, "las entregas en efectivo no van al CRM de Transferencias");
    assert.match(html, /Dashboard manual/);
    assert.match(html, /•••• 5678/, "tarjeta compacta (últimos 4), completa en el title");
    assert.match(html, /WhatsApp/);
    assert.match(html, /5511987654321/, "muestra el teléfono");
    assert.match(html, /R\$ 672/); assert.match(html, /120 USD/);
    assert.match(html, /12\.000 CUP/);
    assert.match(html, /confirmar\('1001', this\)">VERIFICADO/);
    assert.match(html, /completar\('900', this\)">COMPLETAR/);
    assert.match(html, /Ana &lt;b&gt;/, "escapa HTML del nombre");
});

test("CRM: filtros por estado, moneda, origen y búsqueda", () => {
    const { sandbox, el } = sandboxDashboard();
    sandbox.window._ultimasOperaciones = OPS;
    el("crmTrOrigen").value = "dashboard_manual";
    sandbox.renderCrmTransferencias();
    assert.match(el("tablaCrmTransferencias").innerHTML, /#1001/);
    assert.doesNotMatch(el("tablaCrmTransferencias").innerHTML, /#900/);
    el("crmTrOrigen").value = ""; el("crmTrMoneda").value = "MLC";
    sandbox.renderCrmTransferencias();
    assert.match(el("tablaCrmTransferencias").innerHTML, /#700/);
    assert.doesNotMatch(el("tablaCrmTransferencias").innerHTML, /#1001/);
    el("crmTrMoneda").value = ""; el("crmTrEstado").value = "confirmada";
    sandbox.renderCrmTransferencias();
    assert.match(el("tablaCrmTransferencias").innerHTML, /#900/);
    el("crmTrEstado").value = ""; el("crmTrBuscar").value = "11955556666";
    sandbox.renderCrmTransferencias();
    assert.match(el("tablaCrmTransferencias").innerHTML, /#700/);
    assert.doesNotMatch(el("tablaCrmTransferencias").innerHTML, /#900/);
});

test("CRM: columnas pedidas y layout (CRM izquierda; Tasas, Nueva transferencia y Resumen derecha)", () => {
    const html = fs.readFileSync(DASHBOARD_PATH, "utf8");
    for (const th of ["ID", "Fecha", "Cliente / Teléfono", "Moneda", "BRL", "Destino", "Tarjeta/ cuenta", "Estado", "Origen", "Acción"])
        assert.match(html, new RegExp(`<th>${th}</th>`), th);
    assert.match(html, /@media \(max-width: 900px\) \{\s*\.crm-tr-filtros/, "responsive en móvil");
});

test("CRM: al abrir muestra máximo 5; 'Ver todas' muestra el resto y 'Ver menos' vuelve a 5", () => {
    const { sandbox, el } = sandboxDashboard();
    const muchas = Array.from({ length: 8 }, (_, i) => ({
        id: 500 + i, created_at: "2026-09-20T10:00:00Z", nombre: `Cliente ${i}`, phone: "55119000000" + i, tarjeta: "9205000000000000",
        tipo: "brl_cup", status: "pendiente", transferencia: { moneda: "CUP", brl: 100, destino: 12000 }
    }));
    sandbox.window._ultimasOperaciones = muchas;
    const filas = () => (el("tablaCrmTransferencias").innerHTML.match(/<tr>/g) || []).length;
    sandbox.renderCrmTransferencias();
    assert.equal(filas(), 5);
    assert.equal(el("countCrmTransferencias").innerText, 8, "el contador sigue mostrando el total");
    assert.equal(el("btnCrmTrVerMas").style.display, "inline-block");
    assert.equal(el("btnCrmTrVerMas").innerText, "Ver todas (8)");
    sandbox.toggleCrmTransferenciasVerMas();
    assert.equal(filas(), 8);
    assert.equal(el("btnCrmTrVerMas").innerText, "Ver menos");
    sandbox.toggleCrmTransferenciasVerMas();
    assert.equal(filas(), 5);
});

test("CRM: con 5 o menos no aparece 'Ver todas'", () => {
    const { sandbox, el } = sandboxDashboard();
    sandbox.window._ultimasOperaciones = OPS;
    sandbox.renderCrmTransferencias();
    assert.equal(el("btnCrmTrVerMas").style.display, "none");
});

test("layout: CRM a ancho completo y Resumen General junto al Embudo, responsive", () => {
    const html = fs.readFileSync(DASHBOARD_PATH, "utf8");
    assert.doesNotMatch(html, /columna-derecha/, "ya no hay columna vertical");
    assert.match(html, /\.fila-resumen-embudo \{[^}]*grid-template-columns:/);
    assert.match(html, /@media \(max-width: 900px\) \{ \.fila-resumen-embudo \{ grid-template-columns: 1fr; \} \}/);
});
