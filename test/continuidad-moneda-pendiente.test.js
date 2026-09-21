"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — BUG REAL en producción: un cliente preguntaba por la
// tasa del MLC ("tasa del MLC", sin monto), el bot contestaba la tasa y
// preguntaba "¿cuánto quieres enviar?", pero al responder "1000 reales" el
// bot perdía el contexto de MLC y lo cotizaba como BRL→CUP (el flujo por
// defecto). Causa: tasaMLC()/preguntarCantidadUSD() nunca guardaban ningún
// estado -- no había NADA que consultar cuando llegaba el monto.
//
// Fix: reutiliza el mecanismo de "contexto conversacional corto" ya
// existente (customers.ultima_pregunta/ultimas_opciones/
// contexto_actualizado_at, migración 0011, TTL 30 min) -- mismo patrón que
// interpretarSeleccionOpcion/interpretarTarjetaPorPalabra en reglas-bot.js.
// Ver src/services/reglas-bot.js:monedaPendienteDeContexto y el nuevo bloque
// en src/services/openai.js:procesarMensaje.
//
// REGLA QUE SE PRUEBA: NUEVA INTENCIÓN EXPLÍCITA > CONTEXTO ANTERIOR --
// una moneda nombrada en el mensaje ACTUAL (mlc/usd/dólar/cup) siempre gana
// sobre cualquier contexto pendiente. El contexto pendiente SOLO decide
// cuando el mensaje trae un monto sin nombrar ninguna moneda.
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

let cuentaLlamadasGPT = 0;
const imagenFlowPath = require.resolve("../src/flows/imagen-flow");
require.cache[imagenFlowPath] = {
    id: imagenFlowPath, filename: imagenFlowPath, loaded: true,
    exports: {
        detectarImagenUnificada: async () => ({ tipo: "desconocido" }),
        detectarComprobantePDF: async () => ({ valido: false }),
        llamarAsistente: async () => { cuentaLlamadasGPT++; return { texto: "", responseId: null }; }
    }
};

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const { procesarMensaje } = require("../src/services/openai");

const TASAS_DEFAULT = { brl_0: 90, brl_100: 100, brl_500: 110, brl_1000: 120, usd1: 300, mlc: 250 };
const HORA_ATENCION_FIJA = new Date("2026-01-15T17:00:00.000Z").getTime(); // 14:00 en Brasil

function mockMundo(t, { tasas = TASAS_DEFAULT } = {}) {
    t.mock.timers.enable({ apis: ["Date"], now: HORA_ATENCION_FIJA });
    const customers = new Map();

    function aplicarParams(row, params) {
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
        return row;
    }

    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^SELECT phone FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ phone: row.phone }] : [] };
        }
        if (/^SELECT phone, estado_crm FROM customers/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ phone: row.phone, estado_crm: row.estado_crm || null }] : [] };
        }
        if (/^SELECT \* FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ ...row }] : [] };
        }
        if (/^SELECT nivel_vip FROM customers/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: [{ nivel_vip: row?.nivel_vip || 0 }] };
        }
        if (/INSERT INTO customers \(phone, pausa_hasta/.test(sql)) {
            const row = customers.get(params[0]) || { phone: params[0] };
            row.pausa_hasta = new Date(Date.now() + Number(params[1]) * 60000).toISOString();
            customers.set(params[0], row);
            return { rows: [] };
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
                estado: null, fecha_estado: null, fecha_pix: null, comprobante_pendiente: null,
                valor_comprobante: null, last_response_id: null, ultimo_monto: null, tipo_favorito: null,
                tarjeta_frecuente: null, titular_frecuente: null, banco_favorito: null,
                ultima_pregunta: null, ultimas_opciones: null, contexto_actualizado_at: null
            });
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*tarjeta_frecuente\s*=\s*NULL/.test(sql)) {
            const row = customers.get(params[0]);
            if (row) Object.assign(row, {
                tarjeta_frecuente: null, titular_frecuente: null,
                ultima_pregunta: null, ultimas_opciones: null, contexto_actualizado_at: null
            });
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*ultima_pregunta\s*=\s*NULL/.test(sql)) {
            const row = customers.get(params[0]);
            if (row) Object.assign(row, { ultima_pregunta: null, ultimas_opciones: null, contexto_actualizado_at: null });
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*estado_crm\s*=\s*\$2/.test(sql)) {
            const row = customers.get(params[0]);
            if (row) { row.estado_crm = params[1]; if (params[2] != null) row.idioma = params[2]; }
            return { rows: [] };
        }
        if (/^SELECT pausa_hasta FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ pausa_hasta: row.pausa_hasta || null }] : [] };
        }
        if (/^SELECT \* FROM rates LIMIT 1/.test(sql)) return { rows: [tasas] };
        if (/^SELECT \* FROM ofertas LIMIT 1/.test(sql)) return { rows: [] };
        if (/^SELECT 1 FROM blocked_numbers WHERE phone = \$1/.test(sql)) return { rows: [] };
        if (/^SELECT \* FROM operations WHERE\s+phone = \$1 AND status = 'pendiente'/.test(sql)) return { rows: [] };
        if (/^SELECT id FROM operations WHERE phone = \$1 AND status = 'pendiente' AND monto = \$2/.test(sql)) return { rows: [] };
        if (/INSERT INTO operations/.test(sql)) return { rows: [{ id: 1, phone: params[0], monto: params[2], status: "pendiente" }] };
        return { rows: [] };
    });

    return { customers };
}

test.beforeEach(() => { cuentaLlamadasGPT = 0; mensajesEnviados = []; });

function ultimoMensaje() { return mensajesEnviados[mensajesEnviados.length - 1]?.msg || ""; }

// Contexto MLC pendiente: como lo deja tasaMLC() tras "tasa del MLC" (sin monto).
function contextoMLCPendiente() {
    return { estado: null, ultima_pregunta: "moneda_pendiente", ultimas_opciones: ["mlc"], contexto_actualizado_at: new Date().toISOString() };
}
function contextoUSDPendiente(tipo = "usd_clasica") {
    return { estado: null, ultima_pregunta: "moneda_pendiente", ultimas_opciones: [tipo], contexto_actualizado_at: new Date().toISOString() };
}
// Contexto CUP ya cotizado (como deja cotizarBRL con un monto real).
function contextoCUPCotizado() {
    return { estado: "cotizacion_realizada", tipo_favorito: "brl_cup", ultimo_monto: 500, fecha_cotizacion: new Date().toISOString() };
}

// ── 1. Caso real: "tasa del MLC" establece contexto, "1000 reales" continúa MLC ──

test("tasaMLC deja el contexto pendiente (moneda_pendiente=mlc) tras contestar la tasa sin monto", async (t) => {
    const mundo = mockMundo(t);
    await procesarMensaje("5511900010001", "a como esta la tasa del mlc", "Cliente");
    const row = mundo.customers.get("5511900010001");
    assert.equal(row.ultima_pregunta, "moneda_pendiente");
    assert.deepEqual(row.ultimas_opciones, ["mlc"]);
    assert.match(ultimoMensaje(), /MLC hoy/);
});

test('BUG REAL: contexto MLC pendiente + "1000 reales" -> cotiza MLC, NO CUP', async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900010002", { phone: "5511900010002", ...contextoMLCPendiente() });
    await procesarMensaje("5511900010002", "1000 reales", "Cliente");
    const msg = ultimoMensaje();
    assert.match(msg, /MLC/i);
    assert.doesNotMatch(msg, /CUP/);
    assert.equal(cuentaLlamadasGPT, 0, "se resuelve con reglas deterministas, nunca con el fallback de GPT");
});

// ── 2. Contexto MLC + número suelto "1000" -> MLC ──

test('contexto MLC pendiente + "1000" (número suelto) -> continúa MLC', async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900010003", { phone: "5511900010003", ...contextoMLCPendiente() });
    await procesarMensaje("5511900010003", "1000", "Cliente");
    assert.match(ultimoMensaje(), /MLC/i);
});

// ── 3. Contexto MLC + "quiero enviar 1000 reales" -> MLC ──

test('contexto MLC pendiente + "quiero enviar 1000 reales" -> continúa MLC', async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900010004", { phone: "5511900010004", ...contextoMLCPendiente() });
    await procesarMensaje("5511900010004", "quiero enviar 1000 reales", "Cliente");
    assert.match(ultimoMensaje(), /MLC/i);
});

// ── 4. Contexto MLC + intención explícita distinta ("mejor en CUP") -> cambia a CUP ──

test('contexto MLC pendiente + "mejor en cup, quiero enviar 1000 reales" -> intención explícita gana, cotiza CUP no MLC', async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900010005", { phone: "5511900010005", ...contextoMLCPendiente() });
    await procesarMensaje("5511900010005", "mejor en cup, quiero enviar 1000 reales", "Cliente");
    const msg = ultimoMensaje();
    assert.match(msg, /CUP/);
    assert.doesNotMatch(msg, /MLC/i);
});

// ── 5. Contexto CUP (ya cotizado) + "1000 reales" -> sigue CUP (comportamiento ya existente) ──

test('contexto CUP ya cotizado + "1000 reales" -> continúa CUP', async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900010006", { phone: "5511900010006", ...contextoCUPCotizado() });
    await procesarMensaje("5511900010006", "1000 reales", "Cliente");
    const msg = ultimoMensaje();
    assert.match(msg, /CUP/);
    assert.doesNotMatch(msg, /MLC/i);
});

// ── 6. Contexto CUP + intención explícita "mejor en MLC" -> cambia a MLC ──

test('contexto CUP ya cotizado + "mejor en mlc 1000" -> cambia a MLC', async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900010007", { phone: "5511900010007", ...contextoCUPCotizado() });
    await procesarMensaje("5511900010007", "mejor en mlc 1000", "Cliente");
    assert.match(ultimoMensaje(), /MLC/i);
});

// ── 7. Contexto USD pendiente + cantidad ambigua -> continúa USD ──

test('preguntarCantidadUSD deja el contexto pendiente (moneda_pendiente=usd_clasica)', async (t) => {
    const mundo = mockMundo(t);
    await procesarMensaje("5511900010008", "quiero usd", "Cliente");
    const row = mundo.customers.get("5511900010008");
    assert.equal(row.ultima_pregunta, "moneda_pendiente");
    assert.deepEqual(row.ultimas_opciones, ["usd_clasica"]);
});

test('contexto USD pendiente + cantidad ambigua ("1000") -> continúa USD, no CUP', async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900010009", { phone: "5511900010009", ...contextoUSDPendiente() });
    await procesarMensaje("5511900010009", "1000", "Cliente");
    const msg = ultimoMensaje();
    assert.match(msg, /USD/);
    assert.doesNotMatch(msg, /CUP/);
});

// ── 8. Sin contexto previo + "1000 reales" -> comportamiento seguro actual (CUP), nunca inventa MLC/USD ──

test('sin contexto previo + "1000 reales" -> sigue cotizando CUP por defecto (no inventa moneda)', async (t) => {
    const mundo = mockMundo(t);
    await procesarMensaje("5511900010010", "1000 reales", "Cliente");
    const msg = ultimoMensaje();
    assert.match(msg, /CUP/);
    assert.doesNotMatch(msg, /MLC/i);
});

// ── 9. Tasas y cálculos siguen saliendo exclusivamente del backend (rates) ──

test("el monto MLC cotizado por continuidad usa la tasa real de `rates`, nunca un valor fijo", async (t) => {
    const mundo = mockMundo(t, { tasas: { ...TASAS_DEFAULT, mlc: 333 } });
    mundo.customers.set("5511900010011", { phone: "5511900010011", ...contextoMLCPendiente() });
    await procesarMensaje("5511900010011", "1000 reales", "Cliente");
    // R$1000 = 1000/333 MLC -> calcularOperacion(tipo:"mlc") en realidad cotiza
    // "valorFinal MLC -> R$"; lo que importa aquí es que el número que aparece
    // en el mensaje coincide con la tasa mockeada (333), no un valor hardcodeado.
    assert.match(ultimoMensaje(), /333/);
});

// ── 10. TTL de 30 minutos sigue respetándose ──

test("contexto MLC pendiente VENCIDO (31 min) -> NO se usa, cae al comportamiento por defecto (CUP)", async (t) => {
    const mundo = mockMundo(t);
    const hace31min = new Date(Date.now() - 31 * 60000).toISOString();
    mundo.customers.set("5511900010012", {
        phone: "5511900010012", estado: null,
        ultima_pregunta: "moneda_pendiente", ultimas_opciones: ["mlc"],
        contexto_actualizado_at: hace31min
    });
    await procesarMensaje("5511900010012", "1000 reales", "Cliente");
    const msg = ultimoMensaje();
    assert.match(msg, /CUP/);
    assert.doesNotMatch(msg, /MLC/i);
});

test("contexto MLC pendiente vigente (29 min) -> SÍ se usa", async (t) => {
    const mundo = mockMundo(t);
    const hace29min = new Date(Date.now() - 29 * 60000).toISOString();
    mundo.customers.set("5511900010013", {
        phone: "5511900010013", estado: null,
        ultima_pregunta: "moneda_pendiente", ultimas_opciones: ["mlc"],
        contexto_actualizado_at: hace29min
    });
    await procesarMensaje("5511900010013", "1000 reales", "Cliente");
    assert.match(ultimoMensaje(), /MLC/i);
});
