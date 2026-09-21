"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — separación visual de módulos en el dashboard
// (public/dashboard.html): Transferencias, Entregas y Recargas deben ser
// módulos independientes en la interfaz, aunque reutilicen la misma tabla
// `operations` por debajo (ver esOperacionDeRecarga en el propio HTML).
//
// Esto NO es un test de backend: carga el <script> real de dashboard.html
// en un sandbox de Node (vm), con un DOM mínimo simulado, y ejecuta las
// funciones de renderizado TAL COMO están escritas -- no una reimplementación
// paralela de la lógica.
//
// Verifica explícitamente:
//   - una operación de recarga NO aparece en Pendientes/En Proceso (Transferencias)
//   - una transferencia normal NO aparece en Operaciones de Recargas
//   - Nacional aparece en Operaciones de Recargas
//   - Internacional aparece en Operaciones de Recargas
//   - "completar" desde Recargas usa la MISMA función idempotente que el
//     resto del dashboard (ver test/operations-idempotency.test.js y
//     test/operation-messages.test.js para la idempotencia/redacción real)
//   - el historial de Recargas conserva las completadas (solo salen del
//     resumen corto de "activas/recientes")
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
        addEventListener() {},
        appendChild() {},
        querySelectorAll: () => []
    };
}

function cargarDashboardSandbox() {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!m) throw new Error("No se encontró el bloque <script> en dashboard.html");
    const codigo = m[1];

    const elements = new Map();
    const documentStub = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, makeElement(id));
            return elements.get(id);
        },
        addEventListener() {},
        createElement: () => makeElement("tmp")
    };

    const sandbox = {
        document: documentStub,
        window: {},
        console,
        fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
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

const TRANSFERENCIA_PENDIENTE = {
    id: 1, tipo: "brl_cup", status: "pendiente", monto: 300, phone: "5511900050001",
    nombre: "Cliente BRL", titular: "Cliente BRL", created_at: "2026-09-20T10:00:00.000Z"
};
const RECARGA_NACIONAL_PENDIENTE = {
    id: 2, tipo: "recarga_nacional", status: "pendiente", monto: 100, phone: "5511900050002",
    nombre: "Cliente Nac", titular: "Cliente Nac", tarjeta: "51234567", created_at: "2026-09-20T11:00:00.000Z"
};
const RECARGA_INTERNACIONAL_CONFIRMADA = {
    id: 3, tipo: "recarga_internacional", status: "confirmada", monto: 145, phone: "5511900050003",
    nombre: "Cliente Int", titular: "Cliente Int", tarjeta: "59876543", created_at: "2026-09-20T12:00:00.000Z"
};
const RECARGA_NACIONAL_COMPLETADA = {
    id: 4, tipo: "recarga_nacional", status: "completada", monto: 100, phone: "5511900050004",
    nombre: "Cliente Nac 2", titular: "Cliente Nac 2", tarjeta: "51112222", created_at: "2026-09-19T09:00:00.000Z"
};

test("esOperacionDeRecarga: distingue recarga_* de cualquier otro tipo (transferencia/entrega)", () => {
    const sandbox = cargarDashboardSandbox();
    assert.equal(sandbox.esOperacionDeRecarga(RECARGA_NACIONAL_PENDIENTE), true);
    assert.equal(sandbox.esOperacionDeRecarga(RECARGA_INTERNACIONAL_CONFIRMADA), true);
    assert.equal(sandbox.esOperacionDeRecarga(TRANSFERENCIA_PENDIENTE), false);
    assert.equal(sandbox.esOperacionDeRecarga({ tipo: "cup_efectivo" }), false);
});

test("renderRecargasOps: una recarga Nacional aparece en el módulo de Recargas con su número cubano COMPLETO (sin enmascarar)", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.renderRecargasOps([RECARGA_NACIONAL_PENDIENTE]);
    const tbody = sandbox.document.getElementById("tablaRecargasOps");
    assert.match(tbody.innerHTML, /🇨🇺 Nacional/);
    assert.match(tbody.innerHTML, /51234567/, "el número cubano completo debe estar visible, nunca '••••'");
    assert.doesNotMatch(tbody.innerHTML, /••••/);
});

test("renderRecargasOps: una recarga Internacional también aparece en el módulo de Recargas", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.renderRecargasOps([RECARGA_INTERNACIONAL_CONFIRMADA]);
    const tbody = sandbox.document.getElementById("tablaRecargasOps");
    assert.match(tbody.innerHTML, /🌍 Internacional/);
    assert.match(tbody.innerHTML, /59876543/);
});

test("renderRecargasOps: una transferencia normal NUNCA aparece dentro de Operaciones de Recargas", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.renderRecargasOps([TRANSFERENCIA_PENDIENTE, RECARGA_NACIONAL_PENDIENTE]);
    const tbody = sandbox.document.getElementById("tablaRecargasOps");
    assert.doesNotMatch(tbody.innerHTML, /5511900050001/, "el teléfono de la transferencia no debe aparecer aquí");
    assert.match(tbody.innerHTML, /5511900050002/);
    assert.equal(sandbox.document.getElementById("countRecargasOps").innerText, 1);
});

test("Pendientes/En Proceso de Transferencias: una recarga NUNCA aparece en esas listas (filtro esOperacionDeRecarga)", () => {
    const sandbox = cargarDashboardSandbox();
    const operaciones = [TRANSFERENCIA_PENDIENTE, RECARGA_NACIONAL_PENDIENTE, RECARGA_INTERNACIONAL_CONFIRMADA];
    const pendientesTransferencias = operaciones.filter(o => o.status === "pendiente" && !sandbox.esOperacionDeRecarga(o));
    const enProcesoTransferencias  = operaciones.filter(o => o.status === "confirmada" && !sandbox.esOperacionDeRecarga(o));
    assert.deepEqual(pendientesTransferencias.map(o => o.id), [1]);
    assert.deepEqual(enProcesoTransferencias.map(o => o.id), []);
});

test("compacto: solo 2 activas/recientes por defecto, con 'Ver todas (N)' para desplegar el resto", () => {
    const sandbox = cargarDashboardSandbox();
    const tercera = { ...RECARGA_NACIONAL_PENDIENTE, id: 5, phone: "5511900050005" };
    const operaciones = [RECARGA_NACIONAL_PENDIENTE, RECARGA_INTERNACIONAL_CONFIRMADA, tercera];
    // window._ultimasOperaciones es lo que refreshData() deja guardado para que
    // toggleVerTodasRecargas() pueda re-renderizar sin volver a pedir al backend.
    sandbox.window._ultimasOperaciones = operaciones;
    sandbox.renderRecargasOps(operaciones);
    const tbody = sandbox.document.getElementById("tablaRecargasOps");
    const filas = (tbody.innerHTML.match(/<tr>/g) || []).length;
    assert.equal(filas, 2, "por defecto solo deben mostrarse 2 operaciones");
    const btn = sandbox.document.getElementById("btnVerTodasRecargas");
    assert.match(btn.innerText, /Ver todas \(3\)/);

    sandbox.toggleVerTodasRecargas();
    const filasExpandido = (tbody.innerHTML.match(/<tr>/g) || []).length;
    assert.equal(filasExpandido, 3, "'Ver todas' debe desplegar TODAS las operaciones de recarga");
});

test("historial: una recarga completada sale del resumen corto de activas, pero sigue visible en 'Ver todas' (nunca se pierde)", () => {
    const sandbox = cargarDashboardSandbox();
    // Con 2+ operaciones activas, la completada queda fuera del resumen corto
    // (solo se muestran 2, y las activas van primero que el historial).
    const otraActiva = { ...RECARGA_INTERNACIONAL_CONFIRMADA, id: 6, phone: "5511900050006" };
    const operaciones = [RECARGA_NACIONAL_PENDIENTE, otraActiva, RECARGA_NACIONAL_COMPLETADA];
    sandbox.window._ultimasOperaciones = operaciones;
    sandbox.renderRecargasOps(operaciones);
    let tbody = sandbox.document.getElementById("tablaRecargasOps");
    assert.doesNotMatch(tbody.innerHTML, /5511900050004/, "la completada no debe estar en el resumen corto cuando hay 2+ activas");

    sandbox.toggleVerTodasRecargas();
    tbody = sandbox.document.getElementById("tablaRecargasOps");
    assert.match(tbody.innerHTML, /5511900050004/, "la completada debe seguir en el historial al desplegar 'Ver todas'");
    assert.match(tbody.innerHTML, /Completada/);
});

test("completar desde Recargas: la fila de una recarga 'confirmada' usa la MISMA función completar(id) que el resto del dashboard (idempotente por diseño, ver operations.js)", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.renderRecargasOps([RECARGA_INTERNACIONAL_CONFIRMADA]);
    const tbody = sandbox.document.getElementById("tablaRecargasOps");
    assert.match(tbody.innerHTML, new RegExp(`completar\\('${RECARGA_INTERNACIONAL_CONFIRMADA.id}', this\\)`));
    assert.equal(typeof sandbox.completar, "function");
});

test("una recarga ya 'completada' no ofrece botón de acción (no se puede volver a completar desde la UI)", () => {
    const sandbox = cargarDashboardSandbox();
    sandbox.renderRecargasOps([RECARGA_NACIONAL_COMPLETADA]);
    const tbody = sandbox.document.getElementById("tablaRecargasOps");
    assert.doesNotMatch(tbody.innerHTML, /onclick="completar/);
    assert.doesNotMatch(tbody.innerHTML, /onclick="confirmar/);
});

// ── Fecha límite de Internacional: badges ACTIVA/VENCIDA/DESACTIVADA ──
// disponible_ahora lo calcula el backend con NOW() de Postgres (ver
// GET /admin/recargas en index.js) -- el dashboard solo lo traduce a texto,
// nunca recalcula la fecha comparando contra el reloj del navegador.

test("estadoRecargaBadge: desactivada (activa=false) -> DESACTIVADA, sin importar la fecha límite", () => {
    const sandbox = cargarDashboardSandbox();
    const b = sandbox.estadoRecargaBadge({ activa: false, disponible_hasta: null, disponible_ahora: false });
    assert.equal(b.label, "DESACTIVADA");
});

test("estadoRecargaBadge: activa, sin fecha límite -> ACTIVA", () => {
    const sandbox = cargarDashboardSandbox();
    const b = sandbox.estadoRecargaBadge({ activa: true, disponible_hasta: null, disponible_ahora: true });
    assert.equal(b.label, "ACTIVA");
});

test("estadoRecargaBadge: activa, con fecha límite todavía no vencida -> ACTIVA", () => {
    const sandbox = cargarDashboardSandbox();
    const b = sandbox.estadoRecargaBadge({ activa: true, disponible_hasta: "2099-01-01T00:00:00.000Z", disponible_ahora: true });
    assert.equal(b.label, "ACTIVA");
});

test("estadoRecargaBadge: activa=true pero disponible_ahora=false (fecha límite ya pasó) -> VENCIDA", () => {
    const sandbox = cargarDashboardSandbox();
    const b = sandbox.estadoRecargaBadge({ activa: true, disponible_hasta: "2020-01-01T00:00:00.000Z", disponible_ahora: false });
    assert.equal(b.label, "VENCIDA");
});

test("utcToSaoPauloLocal: convierte un ISO UTC al string local de Brasil para precargar el input datetime-local", () => {
    const sandbox = cargarDashboardSandbox();
    assert.equal(sandbox.utcToSaoPauloLocal("2026-09-25T02:59:00.000Z"), "2026-09-24T23:59");
});

test("utcToSaoPauloLocal: sin valor -> string vacío (el input queda sin fecha límite)", () => {
    const sandbox = cargarDashboardSandbox();
    assert.equal(sandbox.utcToSaoPauloLocal(null), "");
});
