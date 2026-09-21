"use strict";

// env.js lee process.env.ADMIN_PHONE UNA sola vez al cargarse (ver
// src/config/env.js) -- tiene que quedar seteada antes del primer require
// de cualquier módulo que dependa de ella, por eso va aquí arriba de todo.
process.env.ADMIN_PHONE = "5511900000999";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — revalidación de disponibilidad de recarga
// justo antes de crear la operación real (src/flows/pix-flow.js:
// intentarCompletarOperacion -> recargaSigueActiva).
//
// El cliente puede haber empezado el flujo (elegido modalidad, mandado el
// número, mandado el comprobante) cuando la modalidad SÍ estaba activa, y
// completarlo después de que el admin la desactivó o venció (fecha límite
// de Internacional, migración 0013). Una modalidad desactivada/vencida NO
// puede crear una operación nueva solo porque el cliente empezó antes.
// ─────────────────────────────────────────────────────────

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
const { intentarCompletarOperacion } = require("../src/flows/pix-flow");
const { obtenerCliente } = require("../src/services/customer-memory");

const TASAS = { brl_0: 90, brl_100: 100, brl_500: 110, brl_1000: 120, usd1: 300, usd2: 305 };

function mockMundo(t, { recargaActivaAhora }) {
    const customers = new Map();
    const operations = [];
    let siguienteId = 1;

    function aplicarParamsCustomers(row, params) {
        const set = (i, col) => { if (params[i] != null) row[col] = params[i]; };
        set(1, "nombre"); set(2, "ultimo_monto"); set(3, "tipo_favorito"); set(4, "banco_favorito");
        set(5, "tarjeta_frecuente"); set(6, "titular_frecuente"); set(7, "banco_detectado");
        set(8, "estado"); set(9, "fecha_estado"); set(10, "fecha_cotizacion"); set(11, "fecha_pix");
        set(13, "comprobante_pendiente"); set(14, "valor_comprobante");
        set(22, "comprobante_e2e"); set(23, "comprobante_transaccion_id");
        if (params[24] != null) row.comprobante_datos = JSON.parse(params[24]);
        return row;
    }

    let llamadasRecargaSigueActiva = 0;
    let sqlRecargaSigueActiva = "";

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
                ultimo_monto: null, tipo_favorito: null, tarjeta_frecuente: null
            });
            return { rows: [] };
        }

        if (/^SELECT \* FROM rates LIMIT 1/.test(sql)) return { rows: [TASAS] };

        if (/^SELECT \* FROM operations WHERE comprobante_e2e = \$1/.test(sql)) return { rows: [] };
        if (/^SELECT \* FROM operations WHERE comprobante_transaccion_id = \$1/.test(sql)) return { rows: [] };
        if (/^SELECT \* FROM operations\s+WHERE phone = \$1 AND status = 'pendiente'/.test(sql)) return { rows: [] };

        // Revalidación final -- justo antes de crear la operación.
        if (/SELECT 1 FROM recargas[\s\S]*WHERE tipo = \$1 AND activa = true[\s\S]*disponible_hasta/.test(sql)) {
            llamadasRecargaSigueActiva++;
            sqlRecargaSigueActiva = sql;
            return { rows: recargaActivaAhora ? [{ "?column?": 1 }] : [] };
        }
        if (/SELECT descripcion, precio FROM recargas WHERE tipo = \$1 LIMIT 1/.test(sql)) {
            return { rows: [{ descripcion: "2.000 CUP", precio: 100 }] };
        }

        if (/INSERT INTO operations/.test(sql)) {
            const row = {
                id: siguienteId++, phone: params[0], nombre: params[1], monto: Number(params[2]), cup: Number(params[3]),
                tarjeta: params[4], titular: params[5], banco: params[6], tipo: params[7],
                comprobante_e2e: params[15] || null, comprobante_transaccion_id: params[16] || null,
                status: "pendiente"
            };
            operations.push(row);
            return { rows: [row] };
        }

        return { rows: [] };
    });

    return {
        customers, operations,
        get llamadasRecargaSigueActiva() { return llamadasRecargaSigueActiva; },
        get sqlRecargaSigueActiva() { return sqlRecargaSigueActiva; }
    };
}

test.beforeEach(() => { mensajesEnviados = []; });

test("recargaSigueActiva: la consulta SQL incluye activa=true y la ventana de disponible_hasta (nunca completa una vencida por accidente)", async (t) => {
    const mundo = mockMundo(t, { recargaActivaAhora: true });
    mundo.customers.set("5511900030001", {
        phone: "5511900030001", ultimo_monto: 100, tipo_favorito: "recarga_nacional",
        tarjeta_frecuente: "51234567", comprobante_pendiente: true
    });
    await intentarCompletarOperacion("5511900030001", "Cliente", await obtenerCliente("5511900030001"), true);
    assert.equal(mundo.llamadasRecargaSigueActiva, 1);
    assert.match(mundo.sqlRecargaSigueActiva, /disponible_hasta IS NULL OR disponible_hasta >= NOW\(\)/);
});

test("recarga sigue activa -> crea la operación con normalidad", async (t) => {
    const mundo = mockMundo(t, { recargaActivaAhora: true });
    mundo.customers.set("5511900030002", {
        phone: "5511900030002", ultimo_monto: 100, tipo_favorito: "recarga_nacional",
        tarjeta_frecuente: "51234567", comprobante_pendiente: true
    });
    await intentarCompletarOperacion("5511900030002", "Cliente", await obtenerCliente("5511900030002"), true);
    assert.equal(mundo.operations.length, 1);
    assert.equal(mundo.operations[0].status, "pendiente");
    assert.equal(mundo.operations[0].tipo, "recarga_nacional");
});

test("recarga vencida/desactivada justo antes de crear la operación -> NO crea la operación, preserva el comprobante, avisa alternativa", async (t) => {
    const mundo = mockMundo(t, { recargaActivaAhora: false });
    mundo.customers.set("5511900030003", {
        phone: "5511900030003", ultimo_monto: 145, tipo_favorito: "recarga_internacional",
        tarjeta_frecuente: "51234568", comprobante_pendiente: true
    });
    const r = await intentarCompletarOperacion("5511900030003", "Cliente", await obtenerCliente("5511900030003"), true);

    assert.equal(mundo.operations.length, 0, "no debe crear ninguna operación real");
    assert.equal(r, true, "true = ya se respondió al cliente, procesarComprobante no debe mandar el genérico encima");

    const row = mundo.customers.get("5511900030003");
    assert.equal(row.comprobante_pendiente, true, "el comprobante se preserva -- no se pierde el pago del cliente");

    const textos = mensajesEnviados.map(m => m.msg).join(" | ");
    assert.match(textos, /dejó de estar disponible|ya no está disponible/i);
});

test("recarga vencida: también avisa al admin para seguimiento manual", async (t) => {
    const mundo = mockMundo(t, { recargaActivaAhora: false });
    mundo.customers.set("5511900030004", {
        phone: "5511900030004", ultimo_monto: 100, tipo_favorito: "recarga_nacional",
        tarjeta_frecuente: "51234567", comprobante_pendiente: true
    });
    await intentarCompletarOperacion("5511900030004", "Cliente", await obtenerCliente("5511900030004"), true);
    const avisoAdmin = mensajesEnviados.find(m => m.phone === "5511900000999");
    assert.ok(avisoAdmin, "debe avisar al admin");
    assert.match(avisoAdmin.msg, /RECARGA VENCIDA\/DESACTIVADA/i);
});

test("operación que NO es de recarga (brl_cup) -> nunca consulta recargaSigueActiva", async (t) => {
    const mundo = mockMundo(t, { recargaActivaAhora: false });
    mundo.customers.set("5511900030005", {
        phone: "5511900030005", ultimo_monto: 300, tipo_favorito: "brl_cup",
        tarjeta_frecuente: "1111222233334444", comprobante_pendiente: true
    });
    await intentarCompletarOperacion("5511900030005", "Cliente", await obtenerCliente("5511900030005"), true);
    assert.equal(mundo.llamadasRecargaSigueActiva, 0);
    assert.equal(mundo.operations.length, 1, "una transferencia normal no debe verse afectada por la revalidación de recargas");
});
