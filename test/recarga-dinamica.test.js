"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — recargas dinámicas desde el dashboard
// (src/flows/recarga-flow.js). El dashboard (Configuración de Recargas)
// es la fuente de verdad: leerRecargas() ya filtraba "activa = true"; lo
// que se agrega en esta fase es la REDACCIÓN correcta según cuántas
// modalidades resultan activas, y la revalidación de disponibilidad antes
// de completar un flujo ya empezado.
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
const { leerRecargas, mostrarMenuRecargas, seleccionarRecarga, procesarNumeroRecarga } = require("../src/flows/recarga-flow");

test.beforeEach(() => { mensajesEnviados = []; });

function mockRecargas(t, recargasActivas) {
    const customers = new Map();
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^SELECT \* FROM recargas WHERE activa = true/.test(sql)) {
            return { rows: recargasActivas };
        }
        if (/^SELECT phone FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ phone: row.phone }] : [] };
        }
        if (/^SELECT \* FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ ...row }] : [] };
        }
        if (/INSERT INTO customers/.test(sql) || /UPDATE customers SET/.test(sql)) {
            const row = customers.get(params[0]) || { phone: params[0] };
            // Suficiente para estos tests: capturamos monto/tipo/estado por posición
            // (mismo orden que guardarCliente en customer-memory.js).
            if (params[2] != null) row.ultimo_monto = params[2];
            if (params[3] != null) row.tipo_favorito = params[3];
            if (params[8] != null) row.estado = params[8];
            if (params[5] != null) row.tarjeta_frecuente = params[5];
            customers.set(params[0], row);
            return { rows: [] };
        }
        return { rows: [] };
    });
    return customers;
}

const NACIONAL = { tipo: "nacional", precio: 100, descripcion: "2.000 CUP", activa: true };
const INTERNACIONAL = { tipo: "internacional", precio: 145, descripcion: "600 CUP x6", activa: true };

test("solo Nacional activa -> ofrece únicamente Nacional, sin decir 'tenemos dos'", async (t) => {
    mockRecargas(t, [NACIONAL]);
    const msg = await mostrarMenuRecargas("5511900000001");
    assert.match(msg, /Recarga Nacional/i);
    assert.doesNotMatch(msg, /internacional/i);
    assert.doesNotMatch(msg, /tenemos dos/i);
});

test("solo Internacional activa -> ofrece únicamente Internacional", async (t) => {
    mockRecargas(t, [INTERNACIONAL]);
    const msg = await mostrarMenuRecargas("5511900000002");
    assert.match(msg, /Recarga Internacional/i);
    assert.doesNotMatch(msg, /Recarga Nacional/i);
});

test("ambas activas -> ofrece las dos", async (t) => {
    mockRecargas(t, [NACIONAL, INTERNACIONAL]);
    const msg = await mostrarMenuRecargas("5511900000003");
    assert.match(msg, /Recarga Nacional/i);
    assert.match(msg, /Recarga Internacional/i);
});

test("ninguna activa -> no ofrece una recarga inexistente, explica que no está disponible", async (t) => {
    mockRecargas(t, []);
    await mostrarMenuRecargas("5511900000004");
    const ultimo = mensajesEnviados[mensajesEnviados.length - 1]?.msg || "";
    assert.match(ultimo, /no tenemos recargas disponibles/i);
});

test("leerRecargas: refleja exactamente lo que el dashboard tiene activo ahora mismo", async (t) => {
    mockRecargas(t, [NACIONAL]);
    const recargas = await leerRecargas();
    assert.equal(recargas.length, 1);
    assert.equal(recargas[0].tipo, "nacional");
});

test("modalidad desactivada DURANTE el flujo: procesarNumeroRecarga revalida antes de completar", async (t) => {
    const customers = mockRecargas(t, []); // el admin ya desactivó todo para cuando llega el número
    customers.set("5511900000005", { phone: "5511900000005", tipo_favorito: "recarga_nacional", estado: "aguardando_numero_recarga" });

    const r = await procesarNumeroRecarga("5511900000005", "58888888", true);

    assert.match(mensajesEnviados.map(m => m.msg).join(" | "), /ya no está disponible/i);
    const row = customers.get("5511900000005");
    assert.notEqual(row.estado, "aguardando_comprovante", "no debe completar la operación con una modalidad ya desactivada");
});

test("modalidad SIGUE activa: procesarNumeroRecarga completa con normalidad", async (t) => {
    const customers = mockRecargas(t, [NACIONAL]);
    customers.set("5511900000006", { phone: "5511900000006", tipo_favorito: "recarga_nacional", estado: "aguardando_numero_recarga" });

    await procesarNumeroRecarga("5511900000006", "58888888", true);

    const row = customers.get("5511900000006");
    assert.equal(row.estado, "aguardando_comprovante");
    assert.equal(row.tarjeta_frecuente, "58888888");
});

test("seleccionarRecarga: si la lista se redujo entre mostrar el menú y elegir, no ofrece una opción inexistente", async (t) => {
    mockRecargas(t, [NACIONAL]); // ya solo queda 1 activa
    await seleccionarRecarga("5511900000007", "2"); // el cliente había visto "2" cuando había dos
    const ultimo = mensajesEnviados[mensajesEnviados.length - 1]?.msg || "";
    assert.doesNotMatch(ultimo, /Responde 1 o 2/, "no debe ofrecer una opción 2 que ya no existe");
});
