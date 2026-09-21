"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — avisos al ADMIN sobre comprobantes (I2, I5, C1 de
// la auditoría de 7728e66).
//
// Aislado en su propio archivo porque necesita ADMIN_PHONE configurado
// ANTES de que se cargue src/config/env.js (que lee process.env una sola
// vez al importarse) -- si se mezclara con test/pix-flow-comprobante.test.js
// (donde ADMIN_PHONE se asume vacío para que "el último mensaje" sea
// siempre el del cliente), rompería esos asserts.
// ─────────────────────────────────────────────────────────

process.env.ADMIN_PHONE = "5511900000001";

let mensajesEnviados = [];
const zapiPath = require.resolve("../src/services/zapi");
require.cache[zapiPath] = {
    id: zapiPath, filename: zapiPath, loaded: true,
    exports: {
        enviarMensaje: async (phone, msg) => { mensajesEnviados.push({ phone, msg }); return true; },
        enviarImagen: async () => {},
        enviarConDelay: async (phone, msg) => { mensajesEnviados.push({ phone, msg }); },
        mostrarEscribiendo: async () => {},
        calcularDelay: () => 0
    }
};

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const { procesarComprobante } = require("../src/flows/pix-flow");
const { obtenerCliente } = require("../src/services/customer-memory");
const { getAdminPhone } = require("../src/flows/shared");

const TASAS = { brl_0: 90, brl_100: 100, brl_500: 110, brl_1000: 120 };
const ADMIN = getAdminPhone();

function mockMundo(t) {
    const customers = new Map();
    const operations = [];
    let siguienteId = 1;
    let forzarFalloGenerico = false;

    function aplicarParamsCustomers(row, params) {
        const set = (i, col) => { if (params[i] != null) row[col] = params[i]; };
        set(1, "nombre"); set(2, "ultimo_monto"); set(3, "tipo_favorito"); set(4, "banco_favorito");
        set(5, "tarjeta_frecuente"); set(6, "titular_frecuente"); set(7, "banco_detectado");
        set(8, "estado"); set(9, "fecha_estado"); set(10, "fecha_cotizacion"); set(11, "fecha_pix");
        if (params[12] != null) row.tarjetas = JSON.parse(params[12]);
        set(13, "comprobante_pendiente"); set(14, "valor_comprobante"); set(15, "ultima_interaccion");
        set(16, "saludo_enviado"); set(17, "last_response_id"); set(18, "ultimo_aviso_entrega");
        set(19, "ultima_pregunta");
        if (params[20] != null) row.ultimas_opciones = JSON.parse(params[20]);
        set(21, "contexto_actualizado_at");
        set(22, "comprobante_e2e"); set(23, "comprobante_transaccion_id");
        if (params[24] != null) row.comprobante_datos = JSON.parse(params[24]);
        return row;
    }

    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^SELECT phone FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ phone: row.phone }] : [] };
        }
        if (/^SELECT \* FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ ...row }] : [] };
        }
        if (/INSERT INTO customers/.test(sql)) {
            const row = aplicarParamsCustomers({ phone: params[0] }, params);
            customers.set(params[0], row);
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*nombre\s*=\s*COALESCE/.test(sql)) {
            const row = aplicarParamsCustomers(customers.get(params[0]) || { phone: params[0] }, params);
            customers.set(params[0], row);
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*estado\s*=\s*NULL/.test(sql)) {
            const row = customers.get(params[0]);
            if (row) Object.assign(row, {
                estado: null, comprobante_pendiente: null, valor_comprobante: null,
                comprobante_e2e: null, comprobante_transaccion_id: null, comprobante_datos: null,
                ultimo_monto: null, tipo_favorito: null, tarjeta_frecuente: null, titular_frecuente: null
            });
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*comprobante_pendiente\s*=\s*NULL/.test(sql)) {
            const row = customers.get(params[0]);
            if (row) Object.assign(row, {
                comprobante_pendiente: null, valor_comprobante: null,
                comprobante_e2e: null, comprobante_transaccion_id: null, comprobante_datos: null
            });
            return { rows: [] };
        }

        if (/^SELECT \* FROM rates LIMIT 1/.test(sql)) return { rows: [TASAS] };

        if (/^SELECT \* FROM operations WHERE comprobante_e2e = \$1/.test(sql)) {
            const fila = operations.find(o => o.comprobante_e2e === params[0] && o.status !== "rechazada");
            return { rows: fila ? [fila] : [] };
        }
        if (/^SELECT \* FROM operations\s+WHERE phone = \$1 AND status = 'pendiente'/.test(sql)) {
            const rows = operations.filter(o => o.phone === params[0] && o.status === "pendiente");
            return { rows: rows.length ? [rows[rows.length - 1]] : [] };
        }
        if (/^SELECT id FROM operations WHERE phone = \$1 AND status = 'pendiente' AND monto = \$2/.test(sql)) {
            const rows = operations.filter(o => o.phone === params[0] && o.status === "pendiente" && Number(o.monto) === Number(params[1]));
            return { rows: rows.map(o => ({ id: o.id })) };
        }
        if (/INSERT INTO operations/.test(sql)) {
            if (forzarFalloGenerico) { forzarFalloGenerico = false; throw new Error("conexión perdida (simulado)"); }
            const row = {
                id: siguienteId++, phone: params[0], nombre: params[1], monto: Number(params[2]), cup: Number(params[3]),
                tarjeta: params[4], titular: params[5], banco: params[6], tipo: params[7],
                comprobante_e2e: params[15] || null, comprobante_transaccion_id: params[16] || null,
                comprobante_datos: params[17] ? JSON.parse(params[17]) : null, status: "pendiente"
            };
            operations.push(row);
            return { rows: [row] };
        }

        return { rows: [] };
    });

    return { customers, operations, forzarFalloGenerico: () => { forzarFalloGenerico = true; } };
}

test.beforeEach(() => { mensajesEnviados = []; });

const DATOS_BASE = {
    tipo: "comprovante_pix", valor: 300, fecha: "01/02/2026", hora: "10:00",
    banco: "Nubank", pagador: "Cliente Test",
    destino_correcto: true, valido: true
};

// ── I2: aviso al admin cuando el mismo E2E llega de otro teléfono ──

test("I2 -- admin recibe aviso explícito cuando el mismo E2E llega desde otro teléfono", async (t) => {
    const mundo = mockMundo(t);
    const e2e = "E44444444202601011000IIIIIIIIIII";
    mundo.customers.set("5511900040001", { phone: "5511900040001", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });
    await procesarComprobante("5511900040001", "Cliente A", await obtenerCliente("5511900040001"), { ...DATOS_BASE, e2e, destinatario: "Yordanys" }, true);
    mensajesEnviados = [];

    mundo.customers.set("5511900040002", { phone: "5511900040002", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "5555666677778888" });
    await procesarComprobante("5511900040002", "Cliente B", await obtenerCliente("5511900040002"), { ...DATOS_BASE, e2e, destinatario: "Yordanys" }, true);

    const alAdmin = mensajesEnviados.filter(m => m.phone === ADMIN).map(m => m.msg).join(" | ");
    assert.match(alAdmin, /otro teléfono/i);
    assert.match(alAdmin, /5511900040002/, "debe indicar qué teléfono lo presentó ahora");
    assert.match(alAdmin, /5511900040001/, "debe indicar a qué teléfono pertenecía la operación original");
});

test("I2 -- mismo teléfono reenviando su propio comprobante NO dispara el aviso de 'otro teléfono'", async (t) => {
    const mundo = mockMundo(t);
    const e2e = "E55555555202601011000JJJJJJJJJJJ";
    mundo.customers.set("5511900040003", { phone: "5511900040003", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });
    await procesarComprobante("5511900040003", "Cliente", await obtenerCliente("5511900040003"), { ...DATOS_BASE, e2e }, true);
    mensajesEnviados = [];

    await procesarComprobante("5511900040003", "Cliente", await obtenerCliente("5511900040003"), { ...DATOS_BASE, e2e }, true);

    const alAdmin = mensajesEnviados.filter(m => m.phone === ADMIN).map(m => m.msg).join(" | ");
    assert.doesNotMatch(alAdmin, /otro teléfono/i);
});

// ── I5: el aviso de destinatario distinto al admin incluye el nombre detectado ──

test("I5 -- aviso al admin de destinatario distinto incluye el nombre REALMENTE detectado", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900040004", { phone: "5511900040004", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });
    await procesarComprobante("5511900040004", "Cliente", await obtenerCliente("5511900040004"),
        { ...DATOS_BASE, e2e: "E10101010202601011000KKKKKKKKKKK", destinatario: "Juan Pérez", destino_correcto: false }, true);

    const alAdmin = mensajesEnviados.filter(m => m.phone === ADMIN).map(m => m.msg).join(" | ");
    assert.match(alAdmin, /no coincide/i);
    assert.match(alAdmin, /Juan Pérez/, "debe incluir el nombre detectado para que el admin pueda juzgar de un vistazo");
});

test("I5 -- destinatario ilegible en el aviso al admin dice 'no legible', nunca inventa un nombre", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900040005", { phone: "5511900040005", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });
    const { destino_correcto, ...sinDestino } = DATOS_BASE;
    await procesarComprobante("5511900040005", "Cliente", await obtenerCliente("5511900040005"),
        { ...sinDestino, e2e: "E20202020202601011000LLLLLLLLLLL", destino_correcto: false, destinatario: null }, true);

    const alAdmin = mensajesEnviados.filter(m => m.phone === ADMIN).map(m => m.msg).join(" | ");
    assert.match(alAdmin, /no legible/i);
});

// ── C1: aviso al admin cuando hay un fallo real de persistencia ──

test("C1 -- fallo real de persistencia también avisa al admin para seguimiento manual", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900040006", { phone: "5511900040006", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });
    mundo.forzarFalloGenerico();

    await procesarComprobante("5511900040006", "Cliente", await obtenerCliente("5511900040006"),
        { ...DATOS_BASE, e2e: "E30303030202601011000MMMMMMMMMMM" }, true);

    const alAdmin = mensajesEnviados.filter(m => m.phone === ADMIN).map(m => m.msg).join(" | ");
    assert.match(alAdmin, /FALLO REGISTRANDO COMPROBANTE/i);
    assert.match(alAdmin, /5511900040006/);
});
