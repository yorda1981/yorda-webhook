"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBA AUTOMÁTICA — fix puntual en src/flows/pedido-web-flow.js
// (manejarTransferencia): el destino en USD/MLC vía la calculadora web
// ahora SÍ se persiste en `operations.cup` (antes solo se guardaba cuando
// la moneda era CUP, dejando 0 para USD/MLC -- el dato se perdía y
// src/services/operadores.js no podía construir el aviso al operador con
// el monto/destino real). No cambia el monto pagado (R$) ni ninguna otra
// regla de negocio.
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
const { procesarPedidoWeb } = require("../src/flows/pedido-web-flow");

test.beforeEach(() => { mensajesEnviados = []; });

function mockMundo(t) {
    let insertParams = null;
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^SELECT \* FROM operations WHERE ref_web = \$1/.test(sql)) return { rows: [] };
        if (/^SELECT nivel_vip FROM customers WHERE phone = \$1/.test(sql)) return { rows: [] };
        if (/INSERT INTO operations/.test(sql)) {
            insertParams = params;
            return { rows: [{ id: 1, phone: params[0], monto: params[2], cup: params[3], tipo: params[7], status: "pendiente" }] };
        }
        if (/^SELECT phone FROM customers WHERE phone = \$1/.test(sql)) return { rows: [] };
        if (/^INSERT INTO customers/.test(sql) || /^UPDATE customers SET/.test(sql)) return { rows: [] };
        return { rows: [] };
    });
    return { getInsertParams: () => insertParams };
}

function mensajeTransferencia({ moneda, recibe, pagadoR$ }) {
    return [
        "NUEVO PEDIDO #ABCD1234",
        "",
        `R$ ${pagadoR$}`,
        "",
        `Recibe: ${recibe} ${moneda}`,
        "",
        "💳 Tarjeta: 9876543210123456",
        "🏦 Banco: BPA",
        "👤 Beneficiario: Cliente Real",
        "📞 Teléfono: 53555555"
    ].join("\n");
}

// Nota: los montos de estos mensajes se escriben SIN separador decimal
// (ej. "560" en vez de "560,00") a propósito -- limpiarNumero() en
// pedido-web-flow.js elimina todo carácter no numérico (incluida la coma
// decimal), un comportamiento preexistente y fuera del alcance de este
// fix puntual; usar enteros evita que ese detalle interfiera con lo que
// esta prueba realmente verifica (que el destino ya no se pierde).

test("transferencia USD vía calculadora web: el destino (100 USD) ahora se guarda en operations.cup, no se pierde", async (t) => {
    const mundo = mockMundo(t);
    const texto = mensajeTransferencia({ moneda: "USD", recibe: "100", pagadoR$: "560" });
    const ok = await procesarPedidoWeb("5511900099001", texto, "Cliente");
    assert.equal(ok, true);

    const params = mundo.getInsertParams();
    assert.ok(params, "debe haber insertado la operación");
    assert.equal(params[7], "usd_transferencia");
    assert.equal(Number(params[2]), 560, "monto sigue siendo el R$ pagado");
    assert.equal(Number(params[3]), 100, "cup ahora guarda el destino real (100 USD), antes quedaba en 0");
});

test("transferencia MLC vía calculadora web: el destino también se guarda", async (t) => {
    const mundo = mockMundo(t);
    const texto = mensajeTransferencia({ moneda: "MLC", recibe: "50", pagadoR$: "270" });
    await procesarPedidoWeb("5511900099002", texto, "Cliente");

    const params = mundo.getInsertParams();
    assert.equal(params[7], "mlc_transferencia");
    assert.equal(Number(params[3]), 50, "cup guarda el destino real (50 MLC)");
});

test("transferencia CUP vía calculadora web: comportamiento sin cambios (ya funcionaba)", async (t) => {
    const mundo = mockMundo(t);
    const texto = mensajeTransferencia({ moneda: "CUP", recibe: "33000", pagadoR$: "300" });
    await procesarPedidoWeb("5511900099003", texto, "Cliente");

    const params = mundo.getInsertParams();
    assert.equal(params[7], "cup_transferencia");
    assert.equal(Number(params[2]), 300);
    assert.equal(Number(params[3]), 33000);
});
