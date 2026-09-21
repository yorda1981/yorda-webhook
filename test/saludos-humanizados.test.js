"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — humanización de saludos (src/services/openai.js:
// manejarSaludo/construirSaludo, src/services/reglas-bot.js:
// franjaPorHora/franjaSaludoExplicita/primerNombreConfiable,
// src/utils/timezone.js:horaSaoPaulo).
//
// NO se tocó el gate `esSaludo` (sigue exigiendo que el mensaje sea
// EXACTAMENTE un saludo suelto, ver openai.js), ni tasas/cálculos/estados/
// contexto financiero/reglas comerciales -- estos tests lo verifican
// explícitamente (ver "prioriza intención" y "nuevo pedido > contexto").
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
const { procesarMensaje, construirSaludo } = require("../src/services/openai");
const { franjaPorHora, franjaSaludoExplicita, primerNombreConfiable } = require("../src/services/reglas-bot");
const { horaSaoPaulo } = require("../src/utils/timezone");

const TASAS_DEFAULT = { brl_0: 90, brl_100: 100, brl_500: 110, brl_1000: 120, usd1: 300, mlc: 250 };

// Horarios de referencia en Brasil (UTC-3, sin horario de verano):
// 09:00 -> mañana, 14:00 -> tarde, 20:00 -> noche. Todos dentro de la
// ventana de atención (8h-23h) para no chocar con el gate de horario.
const UTC_MANANA = new Date("2026-01-15T12:00:00.000Z").getTime(); // 09:00 Brasil
const UTC_TARDE  = new Date("2026-01-15T17:00:00.000Z").getTime(); // 14:00 Brasil
const UTC_NOCHE  = new Date("2026-01-15T23:00:00.000Z").getTime(); // 20:00 Brasil

function mockMundoConversacional(t, { tasas = TASAS_DEFAULT, now = UTC_TARDE } = {}) {
    t.mock.timers.enable({ apis: ["Date"], now });
    const customers = new Map();
    const operations = new Map();
    let siguienteOperationId = 1;

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

        if (/^SELECT \* FROM operations WHERE\s+phone = \$1 AND status = 'pendiente'/.test(sql)) {
            const rows = (operations.get(params[0]) || []).filter(o => o.status === "pendiente");
            return { rows: rows.length ? [rows[rows.length - 1]] : [] };
        }
        if (/^SELECT id FROM operations WHERE phone = \$1 AND status = 'pendiente' AND monto = \$2/.test(sql)) {
            const rows = (operations.get(params[0]) || []).filter(o => o.status === "pendiente" && Number(o.monto) === Number(params[1]));
            return { rows: rows.map(o => ({ id: o.id })) };
        }
        if (/INSERT INTO operations/.test(sql)) {
            const row = { id: siguienteOperationId++, phone: params[0], monto: params[2], status: "pendiente" };
            const arr = operations.get(params[0]) || [];
            arr.push(row);
            operations.set(params[0], arr);
            return { rows: [row] };
        }

        return { rows: [] };
    });

    return { customers, operations };
}

test.beforeEach(() => { cuentaLlamadasGPT = 0; mensajesEnviados = []; });

// ── Unitarios: funciones puras (reglas-bot.js + timezone.js) ──

test("franjaPorHora: distingue mañana/tarde/noche por la hora real de Brasil", () => {
    assert.equal(franjaPorHora(9), "manana");
    assert.equal(franjaPorHora(14), "tarde");
    assert.equal(franjaPorHora(20), "noche");
});

test("franjaSaludoExplicita: reconoce ES/PT, null si el saludo es genérico", () => {
    assert.equal(franjaSaludoExplicita("buenos dias"), "manana");
    assert.equal(franjaSaludoExplicita("boa tarde"), "tarde");
    assert.equal(franjaSaludoExplicita("buenas noches"), "noche");
    assert.equal(franjaSaludoExplicita("boa noite"), "noche");
    assert.equal(franjaSaludoExplicita("hola"), null);
    assert.equal(franjaSaludoExplicita("hi"), null);
});

test("horaSaoPaulo: usa America/Sao_Paulo explícitamente (no un offset a mano)", () => {
    // 17:00 UTC = 14:00 en Brasil (UTC-3, sin horario de verano desde 2019)
    assert.equal(horaSaoPaulo(new Date("2026-01-15T17:00:00.000Z")), 14);
});

// ── Unitarios: construirSaludo (determinista, conjunto fijo) ──

test("construirSaludo: registrado CON nombre confiable -- usa el nombre, coherente con la franja, en las 3 franjas", () => {
    for (const franja of ["manana", "tarde", "noche"]) {
        const s = construirSaludo({ lang: "es", esRegistrado: true, frecuente: false, nombre: "Lourdes", franja });
        assert.match(s, /Lourdes/);
    }
    const manana = construirSaludo({ lang: "es", esRegistrado: true, frecuente: false, nombre: "Lourdes", franja: "manana" });
    const noche  = construirSaludo({ lang: "es", esRegistrado: true, frecuente: false, nombre: "Lourdes", franja: "noche" });
    assert.doesNotMatch(manana, /noches/i);
    assert.doesNotMatch(noche, /días/i);
});

test("construirSaludo: registrado SIN nombre confiable -- nunca interpola 'undefined'/'null', sigue siendo el saludo de registrado", () => {
    const s = construirSaludo({ lang: "es", esRegistrado: true, frecuente: false, nombre: null, franja: "tarde" });
    assert.doesNotMatch(s, /undefined|null/i);
    assert.match(s, /enviar/i, "un registrado sigue recibiendo el cierre orientado a enviar, aunque no tengamos su nombre");
});

test("construirSaludo: cliente NUEVO -- nunca asume intención de enviar, nunca inventa nombre, en las 3 franjas", () => {
    for (const franja of ["manana", "tarde", "noche"]) {
        const s = construirSaludo({ lang: "es", esRegistrado: false, frecuente: false, nombre: null, franja });
        assert.doesNotMatch(s, /enviar|enviar dinero|cuanto/i);
        assert.match(s, /Bienvenido|Gracias por escribirnos/i);
    }
});

test("construirSaludo: cliente frecuente conserva su saludo especial de siempre, sin cambios", () => {
    const s = construirSaludo({ lang: "es", esRegistrado: true, frecuente: true, nombre: "Juan", franja: "tarde" });
    assert.match(s, /Juan/);
    assert.match(s, /de nuevo|Siempre un placer/i);
});

test("construirSaludo: PT también funciona (nuevo y registrado)", () => {
    const nuevo = construirSaludo({ lang: "pt", esRegistrado: false, frecuente: false, nombre: null, franja: "manana" });
    assert.match(nuevo, /Bem-vindo|Obrigado/i);
    const registrado = construirSaludo({ lang: "pt", esRegistrado: true, frecuente: false, nombre: "Maria", franja: "noche" });
    assert.match(registrado, /Maria/);
});

// ── Integración end-to-end (procesarMensaje) ──

test("cliente REGISTRADO (existe en customers, con nombre real) -- saluda con su nombre, no con el genérico de bienvenida", async (t) => {
    const mundo = mockMundoConversacional(t, { now: UTC_TARDE });
    mundo.customers.set("5511900070001", { phone: "5511900070001", nombre: "Lourdes Abreu", saludo_enviado: false });

    await procesarMensaje("5511900070001", "hola", "PerfilWhatsApp");
    const msg = mensajesEnviados[mensajesEnviados.length - 1].msg;
    assert.match(msg, /Lourdes/);
    assert.doesNotMatch(msg, /Bienvenido a Yorda/i);
});

test("cliente NUEVO (no existe en customers) -- bienvenida genérica (cualquiera de las variantes), sin nombre, sin asumir que quiere enviar", async (t) => {
    const mundo = mockMundoConversacional(t, { now: UTC_TARDE });
    await procesarMensaje("5511900070002", "hola", "AlgunPerfil");
    const msg = mensajesEnviados[mensajesEnviados.length - 1].msg;
    assert.match(msg, /Bienvenido a Yorda Envíos|Gracias por escribirnos/i);
    assert.doesNotMatch(msg, /AlgunPerfil/);
    assert.doesNotMatch(msg, /¿Cuánto quieres enviar/i);
});

test("mañana: un cliente nuevo recibe el saludo de mañana según la hora real de Brasil", async (t) => {
    const mundo = mockMundoConversacional(t, { now: UTC_MANANA });
    await procesarMensaje("5511900070003", "hola", "X");
    const msg = mensajesEnviados[mensajesEnviados.length - 1].msg;
    assert.match(msg, /buenos días/i);
    assert.doesNotMatch(msg, /noches|tardes/i);
});

test("tarde: un cliente nuevo recibe el saludo de tarde según la hora real de Brasil", async (t) => {
    const mundo = mockMundoConversacional(t, { now: UTC_TARDE });
    await procesarMensaje("5511900070003", "hola", "X");
    const msg = mensajesEnviados[mensajesEnviados.length - 1].msg;
    assert.match(msg, /tardes/i);
    assert.doesNotMatch(msg, /días|noches/i);
});

test("noche: un cliente nuevo recibe el saludo de noche según la hora real de Brasil", async (t) => {
    const mundo = mockMundoConversacional(t, { now: UTC_NOCHE });
    await procesarMensaje("5511900070003", "hola", "X");
    const msg = mensajesEnviados[mensajesEnviados.length - 1].msg;
    assert.match(msg, /noches/i);
    assert.doesNotMatch(msg, /días|tardes/i);
});

test("saludo EXPLÍCITO ('buenas noches') a las 09:00 de la mañana real -- corresponde con lo que el cliente dijo, no con la hora del servidor", async (t) => {
    const mundo = mockMundoConversacional(t, { now: UTC_MANANA }); // 09:00 Brasil = mañana real
    await procesarMensaje("5511900070004", "buenas noches", "X");
    const msg = mensajesEnviados[mensajesEnviados.length - 1].msg;
    assert.match(msg, /noches/i);
    assert.doesNotMatch(msg, /buenos días/i);
});

test("INTENCIÓN CONCRETA junto al saludo ('hola, quiero mandar 100 reales') -- prioriza la intención, nunca dispara el saludo completo", async (t) => {
    const mundo = mockMundoConversacional(t, { now: UTC_TARDE });
    await procesarMensaje("5511900070005", "hola quiero mandar 100 reales", "X");
    const msg = mensajesEnviados[mensajesEnviados.length - 1].msg;
    assert.match(msg, /CUP/); // resultado de la cotización real
    assert.doesNotMatch(msg, /Bienvenido a Yorda|gusto saludarte|¿En qué te ayudo\?/i);
    assert.equal(cuentaLlamadasGPT, 0);
});

test("NO repetir saludo/nombre: cliente ya saludado en esta conversación -- 'hola' de nuevo no repite el bloque de bienvenida", async (t) => {
    const mundo = mockMundoConversacional(t, { now: UTC_TARDE });
    mundo.customers.set("5511900070006", { phone: "5511900070006", nombre: "Pedro", saludo_enviado: true });

    await procesarMensaje("5511900070006", "hola", "X");
    const msg = mensajesEnviados[mensajesEnviados.length - 1].msg;
    assert.doesNotMatch(msg, /Bienvenido a Yorda|gusto saludarte|qué gusto/i);
    assert.match(msg, /¿Cuánto quieres enviar\?|¿En qué te ayudo\?/);
});

test("NUEVO PEDIDO EXPLÍCITO > contexto anterior: con una cotización previa distinta, un monto nuevo se cotiza directo (no pregunta '¿seguimos con R$100?')", async (t) => {
    const mundo = mockMundoConversacional(t, { now: UTC_TARDE });
    mundo.customers.set("5511900070007", {
        phone: "5511900070007", nombre: "Carlos", saludo_enviado: true,
        estado: "cotizacion_realizada", ultimo_monto: 100, tipo_favorito: "brl_cup",
        fecha_cotizacion: new Date(UTC_TARDE - 5 * 60000).toISOString()
    });

    await procesarMensaje("5511900070007", "buenas tardes quiero enviar 300 reales", "X");
    const msg = mensajesEnviados[mensajesEnviados.length - 1].msg;
    assert.doesNotMatch(msg, /seguimos con el envío de R\$100/i);
    assert.match(msg, /300/);
});
