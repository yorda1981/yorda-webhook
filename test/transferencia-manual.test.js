"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — alta manual de transferencias desde el dashboard
// (crearTransferenciaManual / cotizarTransferenciaManual en
// src/flows/pedido-web-flow.js, calcularTransferenciaManual en
// src/services/calculator.js, mensajeReciboTransferencia en
// src/services/operation-messages.js y el formulario de public/dashboard.html).
//
// zapi se reemplaza en require.cache ANTES de cargar nada (mismo motivo
// que test/crear-entrega-manual-idempotencia.test.js).
// ─────────────────────────────────────────────────────────

let enviados = [];
let whatsappFalla = null; // null | "false" | "throw"
const zapiPath = require.resolve("../src/services/zapi");
require.cache[zapiPath] = {
    id: zapiPath, filename: zapiPath, loaded: true,
    exports: {
        enviarMensaje: async () => true,
        enviarImagen: async () => {},
        enviarConDelay: async (phone, msg) => {
            if (whatsappFalla === "throw") throw new Error("Z-API caída");
            if (whatsappFalla === "false") return false;
            enviados.push({ phone, msg });
            return true;
        },
        mostrarEscribiendo: async () => {},
        calcularDelay: () => 0
    }
};

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pool = require("../db");
const { crearTransferenciaManual, cotizarTransferenciaManual } = require("../src/flows/pedido-web-flow");
const { calcularTransferenciaManual, calcularCUPInversoConTasas } = require("../src/services/calculator");
const { mensajeReciboTransferencia, mensajeConfirmarOperacion, mensajeCompletarOperacion } = require("../src/services/operation-messages");

const TASAS = { brl_0: 90, brl_100: 100, brl_500: 110, brl_1000: 120, usd1: 5.6, usd2: 5.7, mlc: 5.2 };

function mockPool(t, { tasas = TASAS, origenFalla = false } = {}) {
    const estado = { operaciones: [], origenes: new Map(), clientes: [], idem: new Map() };
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^SELECT \* FROM rates LIMIT 1/.test(sql)) return { rows: tasas ? [tasas] : [] };
        if (/INSERT INTO operations/.test(sql)) {
            const row = {
                id: estado.operaciones.length + 1, phone: params[0], nombre: params[1], monto: params[2], cup: params[3],
                tarjeta: params[4], titular: params[5], banco: params[6], tipo: params[7], status: "pendiente"
            };
            estado.operaciones.push(row);
            return { rows: [row] };
        }
        if (/^UPDATE operations SET origen/.test(sql)) {
            if (origenFalla) throw new Error('column "origen" does not exist');
            estado.origenes.set(params[0], params[1]);
            return { rows: [] };
        }
        if (/INSERT INTO customers|UPDATE customers/.test(sql)) { estado.clientes.push(params); return { rows: [] }; }
        if (/^INSERT INTO idempotency_keys/.test(sql)) {
            if (estado.idem.has(params[0])) return { rows: [] };
            estado.idem.set(params[0], null);
            return { rows: [{ key: params[0] }] };
        }
        if (/^SELECT resource_id FROM idempotency_keys/.test(sql)) return { rows: estado.idem.has(params[0]) ? [{ resource_id: estado.idem.get(params[0]) }] : [] };
        if (/^UPDATE idempotency_keys/.test(sql)) { estado.idem.set(params[1], params[0]); return { rows: [] }; }
        if (/^DELETE FROM idempotency_keys/.test(sql)) { estado.idem.delete(params[0]); return { rows: [] }; }
        return { rows: [] };
    });
    return estado;
}

const DATOS = { clienteNombre: "Ana Pérez", telefonoCliente: "11 98765-4321", moneda: "CUP", cantidad: 10000, tarjeta: "9205 1299 1234 5678" };

test.beforeEach(() => { enviados = []; whatsappFalla = null; });

// ── Cálculo (tasas vigentes, mismas fórmulas que la calculadora web) ──

test("calcularTransferenciaManual CUP: tramos inversos, igual que la cotización inversa del bot", () => {
    const c = calcularTransferenciaManual({ moneda: "CUP", cantidad: 10000, tasas: TASAS });
    const inv = calcularCUPInversoConTasas(10000, TASAS);
    assert.deepEqual(c, { moneda: "CUP", tipo: "cup_transferencia", cantidad: 10000, brl: inv.realesNecesarios, tasa: inv.tasaUsada, tasaEtiqueta: "CUP/BRL" });
    assert.equal(c.brl, 100);
    assert.equal(c.tasa, 100);
});

test("calcularTransferenciaManual USD/MLC: floor(cantidad * tasa en R$)", () => {
    assert.deepEqual(calcularTransferenciaManual({ moneda: "usd", cantidad: 100, tasas: TASAS }),
        { moneda: "USD", tipo: "usd_transferencia", cantidad: 100, brl: 560, tasa: 5.6, tasaEtiqueta: "BRL/USD" });
    assert.deepEqual(calcularTransferenciaManual({ moneda: "MLC", cantidad: 50, tasas: TASAS }),
        { moneda: "MLC", tipo: "mlc_transferencia", cantidad: 50, brl: 260, tasa: 5.2, tasaEtiqueta: "BRL/MLC" });
});

test("calcularTransferenciaManual: sin tasa vigente, moneda inválida o cantidad inválida -> null (nunca inventa)", () => {
    assert.equal(calcularTransferenciaManual({ moneda: "MLC", cantidad: 50, tasas: { ...TASAS, mlc: 0 } }), null);
    assert.equal(calcularTransferenciaManual({ moneda: "CUP", cantidad: 5000, tasas: { ...TASAS, brl_500: null } }), null);
    assert.equal(calcularTransferenciaManual({ moneda: "EUR", cantidad: 50, tasas: TASAS }), null);
    assert.equal(calcularTransferenciaManual({ moneda: "USD", cantidad: 0, tasas: TASAS }), null);
    assert.equal(calcularTransferenciaManual({ moneda: "USD", cantidad: 10, tasas: null }), null);
});

// ── Recibo ──

test("mensajeReciboTransferencia: estilo con emojis, datos de la operación y estado PENDIENTE", () => {
    const m = mensajeReciboTransferencia(
        { id: 42, nombre: "Ana", tarjeta: "9205129912345678" },
        { cantidad: 10000, moneda: "CUP", brl: 100, tasa: 100, tasaEtiqueta: "CUP/BRL" }
    );
    for (const e of ["🧾", "💰", "💳", "🇨🇺", "🇧🇷"]) assert.ok(m.includes(e), `falta ${e}`);
    assert.match(m, /#42/);
    assert.match(m, /10\.000 CUP/);
    assert.match(m, /R\$ 100/);
    assert.match(m, /100 CUP\/BRL/);
    assert.match(m, /9205129912345678/);
    assert.match(m, /PENDIENTE/);
});

test("la operación manual usa los MISMOS mensajes de confirmar/completar que cualquier transferencia", () => {
    const op = { id: 1, monto: 100, tipo: "cup_transferencia" };
    assert.match(mensajeConfirmarOperacion(op), /Procederemos a realizar la transferencia a Cuba/);
    assert.match(mensajeCompletarOperacion(op), /transferencia fue completada/);
});

// ── Vista previa ──

test("cotizarTransferenciaManual: devuelve el cálculo vigente sin crear nada", async (t) => {
    const estado = mockPool(t);
    const r = await cotizarTransferenciaManual(DATOS);
    assert.equal(r.success, true);
    assert.equal(r.calculo.brl, 100);
    assert.equal(r.destino, "9205129912345678");
    assert.equal(estado.operaciones.length, 0);
    assert.equal(enviados.length, 0);
});

// ── Creación ──

test("crearTransferenciaManual: crea operación REAL pendiente, guarda origen dashboard_manual y envía el recibo", async (t) => {
    const estado = mockPool(t);
    const r = await crearTransferenciaManual({ ...DATOS, monto: 1 /* el navegador no decide el BRL */ });
    assert.equal(r.success, true);
    assert.equal(r.reciboEnviado, true);
    assert.equal(estado.operaciones.length, 1);
    const op = estado.operaciones[0];
    assert.equal(op.phone, "5511987654321", "teléfono normalizado igual que en WhatsApp");
    assert.equal(op.nombre, "Ana Pérez");
    assert.equal(op.monto, 100, "BRL recalculado en el backend con las tasas vigentes");
    assert.equal(op.cup, 10000);
    assert.equal(op.tipo, "cup_transferencia");
    assert.equal(op.status, "pendiente");
    assert.equal(estado.origenes.get(op.id), "dashboard_manual");
    assert.equal(r.operacion.origen, "dashboard_manual");
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].phone, "5511987654321");
    assert.match(enviados[0].msg, new RegExp(`Recibo de transferencia #${op.id}`));
    assert.ok(estado.clientes.length > 0, "marca al cliente igual que los pedidos de la calculadora");
});

test("crearTransferenciaManual USD: tipo usd_transferencia y BRL = floor(cantidad * usd1)", async (t) => {
    const estado = mockPool(t);
    const r = await crearTransferenciaManual({ ...DATOS, moneda: "USD", cantidad: 100 });
    assert.equal(r.success, true);
    assert.equal(estado.operaciones[0].tipo, "usd_transferencia");
    assert.equal(estado.operaciones[0].monto, 560);
    assert.equal(estado.operaciones[0].cup, 100);
});

for (const modo of ["false", "throw"]) {
    test(`WhatsApp falla (${modo}) -> la operación NO se pierde y el fallo queda registrado`, async (t) => {
        const estado = mockPool(t);
        whatsappFalla = modo;
        const logs = [];
        t.mock.method(console, "log", (l) => logs.push(String(l)));
        t.mock.method(console, "error", () => {});
        const r = await crearTransferenciaManual(DATOS);
        assert.equal(r.success, true);
        assert.equal(r.reciboEnviado, false);
        assert.equal(estado.operaciones.length, 1);
        assert.ok(logs.some(l => l.includes('"EXTERNAL_API_ERROR"') && l.includes("transferencia_manual.recibo")), "registra el fallo");
    });
}

test("si la columna origen todavía no existe (migración pendiente), la operación igual se crea", async (t) => {
    const estado = mockPool(t, { origenFalla: true });
    t.mock.method(console, "error", () => {});
    const r = await crearTransferenciaManual(DATOS);
    assert.equal(r.success, true);
    assert.equal(estado.operaciones.length, 1);
    assert.equal(enviados.length, 1);
});

test("validación: faltan datos o moneda inválida -> error, sin operación ni WhatsApp", async (t) => {
    const estado = mockPool(t);
    for (const malo of [{ clienteNombre: "" }, { telefonoCliente: "" }, { moneda: "EUR" }, { cantidad: 0 }, { tarjeta: "" }]) {
        const r = await crearTransferenciaManual({ ...DATOS, ...malo });
        assert.ok(r.error, JSON.stringify(malo));
    }
    assert.equal(estado.operaciones.length, 0);
    assert.equal(enviados.length, 0);
});

test("sin tasa vigente para la moneda -> error, sin operación", async (t) => {
    const estado = mockPool(t, { tasas: { ...TASAS, mlc: 0 } });
    const r = await crearTransferenciaManual({ ...DATOS, moneda: "MLC", cantidad: 50 });
    assert.match(r.error, /No hay tasa vigente/);
    assert.equal(estado.operaciones.length, 0);
});

test("idempotencia: mismo intento enviado dos veces -> una sola operación y un solo recibo", async (t) => {
    const estado = mockPool(t);
    const a = await crearTransferenciaManual({ ...DATOS, idempotencyKey: "k-1" });
    const b = await crearTransferenciaManual({ ...DATOS, idempotencyKey: "k-1" });
    assert.equal(a.success, true);
    assert.equal(b.duplicado, true);
    assert.equal(b.operacion.id, a.operacion.id);
    assert.equal(estado.operaciones.length, 1);
    assert.equal(enviados.length, 1);
});

// ── Dashboard ──

test("dashboard: formulario vertical 'Nueva transferencia' al lado de las tasas, sin romper el layout", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    // Orden: CRM (ancho completo) -> fila Tasas | Nueva transferencia -> fila Resumen General | Embudo.
    assert.match(html, /<div class="config-section" id="seccionCrmTransferencias">[\s\S]*?<div class="layout-superior">\s*<div class="config-section" id="seccionTasas"[\s\S]*?id="seccionNuevaTransferencia"[\s\S]*?<div class="fila-resumen-embudo">[\s\S]*?📊 Resumen General[\s\S]*?📊 Embudo de Conversión/);
    assert.match(html, /id="seccionNuevaTransferencia"/);
    for (const id of ["tmCliente", "tmTelefono", "tmMoneda", "tmCantidad", "tmTarjeta", "tmPreview", "btnCrearTransferencia"])
        assert.match(html, new RegExp(`id="${id}"`), `falta ${id}`);
    for (const m of ["CUP", "USD", "MLC"]) assert.match(html, new RegExp(`<option value="${m}">${m}</option>`));
    assert.match(html, />Crear operación pendiente</);
    assert.match(html, /id="btnCrearTransferencia"[^>]*disabled/, "no se puede crear sin revisar el cálculo antes");
    assert.match(html, /\/admin\/transferencias\/manual\/cotizar/);
    assert.match(html, /\.layout-superior\s*\{[^}]*grid-template-columns:\s*2fr 1fr/);
});
