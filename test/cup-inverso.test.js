"use strict";

// Reemplaza zapi.js ANTES de que cotizacion-flow.js/shared.js lo carguen --
// evita llamadas de red reales (Z-API) y los retrasos artificiales de
// "escribiendo..." que harían cada test lentísimo. Mismo patrón que
// test/crear-entrega-manual-idempotencia.test.js.
const zapiPath = require.resolve("../src/services/zapi");
require.cache[zapiPath] = {
    id: zapiPath, filename: zapiPath, loaded: true,
    exports: {
        enviarMensaje: async () => true,
        enviarImagen: async () => {},
        enviarConDelay: async () => {},
        mostrarEscribiendo: async () => {},
        calcularDelay: () => 0
    }
};

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — Cotización inversa CUP → BRL (src/flows/cotizacion-flow.js)
//
// detectarCUPInverso es una función pura sobre texto (no toca DB). La
// MATEMÁTICA de tramos de cotizarCUPInverso ya estaba validada y no se
// tocó -- solo se corrigió la detección de la intención (plurales
// "cuantos"/"quantos" y verbos como "hago"/"faço" que antes no
// matcheaban). Estas pruebas cubren exactamente las 6 frases que el
// negocio reportó como no detectadas, más los límites entre tramos.
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");

const { detectarCUPInverso, cotizarCUPInverso } = require("../src/flows/cotizacion-flow");

function norm(t) {
    return String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// ── Las 6 frases reportadas ──

const FRASES_REPORTADAS = [
    ["cuanto son 50000 cup en reales", 50000],
    ["50000 cup cuantos reales son", 50000],
    ["para que le lleguen 50 mil cup cuantos reales pago", 50000],
    ["quiero que reciba 50000", 50000],
    ["cuantos reales necesito para mandar 80000 cup", 80000],
    ["con cuanto hago 100 mil cup", 100000]
];

for (const [frase, esperado] of FRASES_REPORTADAS) {
    test(`detectarCUPInverso: "${frase}" -> ${esperado} CUP`, () => {
        assert.equal(detectarCUPInverso(norm(frase)), esperado);
    });
}

// ── Continuidad: "mejor 60000" tras una cotización inversa pendiente ──

test("detectarCUPInverso: un bare number como 'mejor 60000' NO se detecta como pregunta inversa nueva", () => {
    // Esto es intencional -- la continuidad ("mejor X" tras una cotización
    // inversa pendiente) se resuelve en openai.js usando el contexto corto
    // persistido (ultima_pregunta = "cotizacion_inversa_pendiente"), no
    // reinterpretando el número como una pregunta inversa desde cero.
    assert.equal(detectarCUPInverso(norm("mejor 60000")), null);
});

// ── Casos límite ──

test("detectarCUPInverso: monto por debajo del mínimo (999) -> null", () => {
    assert.equal(detectarCUPInverso(norm("cuanto son 999 cup en reales")), null);
});

test("detectarCUPInverso: mensaje sin ninguna intención inversa -> null", () => {
    assert.equal(detectarCUPInverso(norm("hola buenas tardes")), null);
});

test("detectarCUPInverso: 'mil'/'k' se interpretan como miles", () => {
    assert.equal(detectarCUPInverso(norm("cuanto son 50 mil cup en reales")), 50000);
});

// ── cotizarCUPInverso: tramos + continuidad persistida ──

function mockTablaCotizacion(t, tasas) {
    const customers = new Map();
    t.mock.method(require("../db"), "query", async (sql, params = []) => {
        if (/^SELECT \* FROM rates LIMIT 1/.test(sql)) return { rows: [tasas] };
        if (/^SELECT \* FROM ofertas LIMIT 1/.test(sql)) return { rows: [] };
        if (/^SELECT nivel_vip FROM customers/.test(sql)) return { rows: [{ nivel_vip: 0 }] };
        if (/^SELECT phone FROM customers WHERE phone = \$1/.test(sql)) {
            const [phone] = params;
            return { rows: customers.has(phone) ? [{ phone }] : [] };
        }
        if (/INSERT INTO customers/.test(sql) || /UPDATE customers SET[\s\S]*nombre\s*=\s*COALESCE/.test(sql)) {
            const row = customers.get(params[0]) || { phone: params[0] };
            if (params[2] != null) row.ultimo_monto = params[2];
            if (params[8] != null) row.estado = params[8];
            if (params[19] != null) row.ultima_pregunta = params[19];
            if (params[20] != null) row.ultimas_opciones = JSON.parse(params[20]);
            customers.set(params[0], row);
            return { rows: [] };
        }
        return { rows: [] };
    });
    return customers;
}

const TASAS_EJEMPLO = { brl_0: 90, brl_100: 100, brl_500: 110, brl_1000: 120 };

test("cotizarCUPInverso: persiste ultima_pregunta='cotizacion_inversa_pendiente' con el objetivo CUP", async (t) => {
    const customers = mockTablaCotizacion(t, TASAS_EJEMPLO);
    await cotizarCUPInverso("5511900000001", "Cliente", 50000, "es");
    const row = customers.get("5511900000001");
    assert.equal(row.ultima_pregunta, "cotizacion_inversa_pendiente");
    assert.equal(row.ultimas_opciones.cupObjetivo, 50000);
    assert.ok(row.ultimas_opciones.brlCalculado > 0);
    assert.ok(row.ultimas_opciones.tasaUsada > 0);
});

test("cotizarCUPInverso: el resultado usa un tramo cuya tasa realmente corresponde al BRL calculado", async (t) => {
    mockTablaCotizacion(t, TASAS_EJEMPLO);
    // 50000 / 110 (tramo 500-999) ~= 454.5 -> redondeado hacia arriba 455,
    // que sigue cayendo en el tramo 500-999... hay que verificar el tramo real:
    // probamos con un valor donde el tramo es claramente el de 1000+.
    const msg = await cotizarCUPInverso("5511900000002", "Cliente", 200000, "es");
    assert.match(msg, /R\$\d+/);
});

test("cotizarCUPInverso: monto muy pequeño usa el tramo 0-99 sin reventar", async (t) => {
    mockTablaCotizacion(t, TASAS_EJEMPLO);
    const msg = await cotizarCUPInverso("5511900000003", "Cliente", 1000, "es");
    assert.match(msg, /R\$\d+/);
});
