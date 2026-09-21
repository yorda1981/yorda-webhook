"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — contexto conversacional corto y saludo matutino
// filtrado por bloqueados (src/services/customer-memory.js)
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const {
    guardarCliente, obtenerCliente, limpiarSesionDB, limpiarContextoCorto, obtenerSaludosPendientes
} = require("../src/services/customer-memory");

function mockClientesYBloqueados(t, bloqueados = []) {
    const customers = new Map();
    const bloqueadosSet = new Set(bloqueados);

    function aplicarParams(row, params) {
        const set = (i, col) => { if (params[i] != null) row[col] = params[i]; };
        set(1, "nombre"); set(2, "ultimo_monto"); set(8, "estado");
        if (params[20] != null) row.ultimas_opciones = JSON.parse(params[20]);
        set(19, "ultima_pregunta"); set(21, "contexto_actualizado_at");
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
            const row = aplicarParams({ phone: params[0] }, params);
            customers.set(params[0], row);
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*nombre\s*=\s*COALESCE/.test(sql)) {
            const row = aplicarParams(customers.get(params[0]) || { phone: params[0] }, params);
            customers.set(params[0], row);
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*estado\s*=\s*NULL/.test(sql)) {
            const row = customers.get(params[0]);
            if (row) Object.assign(row, {
                estado: null, ultimo_monto: null, tarjeta_frecuente: null,
                ultima_pregunta: null, ultimas_opciones: null, contexto_actualizado_at: null
            });
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*ultima_pregunta\s*=\s*NULL/.test(sql)) {
            const row = customers.get(params[0]);
            if (row) Object.assign(row, { ultima_pregunta: null, ultimas_opciones: null, contexto_actualizado_at: null });
            return { rows: [] };
        }
        if (/^SELECT phone, nombre FROM customers WHERE saludo_pendiente = true/.test(sql)) {
            return { rows: [...customers.values()].map(c => ({ phone: c.phone, nombre: c.nombre })) };
        }
        if (/^SELECT 1 FROM blocked_numbers WHERE phone = \$1/.test(sql)) {
            return { rows: bloqueadosSet.has(params[0]) ? [{ "?column?": 1 }] : [] };
        }
        return { rows: [] };
    });

    return customers;
}

test("guardarCliente: persiste ultima_pregunta/ultimas_opciones y estampa contexto_actualizado_at", async (t) => {
    mockClientesYBloqueados(t);
    await guardarCliente({ phone: "5511900000001", ultimaPregunta: "tarjeta_pendiente", ultimasOpciones: null });
    const cliente = await obtenerCliente("5511900000001");
    assert.equal(cliente.ultima_pregunta, "tarjeta_pendiente");
    assert.ok(cliente.contexto_actualizado_at, "debe estamparse la fecha al grabar una pregunta nueva");
});

test("guardarCliente: sin ultimaPregunta -> NO estampa contexto_actualizado_at (evita resetear el TTL por accidente)", async (t) => {
    mockClientesYBloqueados(t);
    await guardarCliente({ phone: "5511900000002", ultimaPregunta: "tarjeta_pendiente" });
    await guardarCliente({ phone: "5511900000002", monto: 300 }); // guardado no relacionado al contexto
    const cliente = await obtenerCliente("5511900000002");
    assert.equal(cliente.ultima_pregunta, "tarjeta_pendiente", "un guardado sin pregunta nueva no debe pisar la pregunta pendiente (COALESCE)");
});

test("limpiarSesionDB: limpia también ultima_pregunta/ultimas_opciones/contexto_actualizado_at", async (t) => {
    mockClientesYBloqueados(t);
    await guardarCliente({ phone: "5511900000003", ultimaPregunta: "seleccion_tarjeta", ultimasOpciones: ["1111", "2222"] });
    await limpiarSesionDB("5511900000003");
    const cliente = await obtenerCliente("5511900000003");
    assert.equal(cliente.ultima_pregunta, null);
    assert.equal(cliente.ultimas_opciones, null);
    assert.equal(cliente.contexto_actualizado_at, null);
});

test("limpiarContextoCorto: limpia SOLO el contexto corto, nunca el estado ni el monto", async (t) => {
    mockClientesYBloqueados(t);
    await guardarCliente({ phone: "5511900000004", estado: "aguardando_comprovante", monto: 300, ultimaPregunta: "tarjeta_pendiente" });
    await limpiarContextoCorto("5511900000004");
    const cliente = await obtenerCliente("5511900000004");
    assert.equal(cliente.ultima_pregunta, null);
    assert.equal(cliente.estado, "aguardando_comprovante", "el estado financiero nunca lo toca limpiarContextoCorto");
    assert.equal(Number(cliente.ultimo_monto), 300);
});

test("obtenerSaludosPendientes: excluye a los números bloqueados", async (t) => {
    const customers = mockClientesYBloqueados(t, ["5511900000010"]);
    await guardarCliente({ phone: "5511900000010", nombre: "Bloqueado" });
    await guardarCliente({ phone: "5511900000011", nombre: "Normal" });
    const pendientes = await obtenerSaludosPendientes();
    const telefonos = pendientes.map(p => p.phone);
    assert.ok(!telefonos.includes("5511900000010"), "un número bloqueado nunca debe recibir el saludo matutino");
    assert.ok(telefonos.includes("5511900000011"));
});

test("obtenerSaludosPendientes: sin bloqueados -> devuelve la lista completa", async (t) => {
    mockClientesYBloqueados(t);
    await guardarCliente({ phone: "5511900000012", nombre: "A" });
    await guardarCliente({ phone: "5511900000013", nombre: "B" });
    const pendientes = await obtenerSaludosPendientes();
    assert.equal(pendientes.length, 2);
});
