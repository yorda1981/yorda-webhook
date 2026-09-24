"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS — consulta de estado/seguimiento de una operación propia
// ("cuál es el estado de mi envío", "cómo va mi envío"...). Antes, sin otra
// palabra gatillo, el portón la descartaba en silencio. Ahora se reconoce
// por intención (esConsultaEstadoOperacion en reglas-bot.js) y usa el flujo
// existente de estado (obtenerUltimaOperacion) con el estado REAL.
// Mismo patrón de mocks que test/saludo-contexto-pix.test.js.
// ─────────────────────────────────────────────────────────

let enviados = [];
const zapiPath = require.resolve("../src/services/zapi");
require.cache[zapiPath] = {
    id: zapiPath, filename: zapiPath, loaded: true,
    exports: {
        enviarMensaje: async (phone, msg) => { enviados.push({ phone, msg }); return true; },
        enviarImagen: async () => {},
        enviarConDelay: async (phone, msg) => { enviados.push({ phone, msg }); return true; },
        mostrarEscribiendo: async () => {},
        calcularDelay: () => 0
    }
};

let llamadasGPT = 0;
const imagenFlowPath = require.resolve("../src/flows/imagen-flow");
require.cache[imagenFlowPath] = {
    id: imagenFlowPath, filename: imagenFlowPath, loaded: true,
    exports: {
        detectarImagenUnificada: async () => ({}),
        detectarComprobantePDF: async () => ({}),
        llamarAsistente: async () => { llamadasGPT++; return { texto: "IGNORAR", responseId: null }; }
    }
};

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const { procesarMensaje } = require("../src/services/openai");
const { esConsultaEstadoOperacion } = require("../src/services/reglas-bot");

const AHORA = new Date("2026-01-15T17:00:00.000Z").getTime(); // 14:00 en Brasil
const norm = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function mundo(t, { cliente = null, operaciones = [] } = {}) {
    t.mock.timers.enable({ apis: ["Date"], now: AHORA });
    const escrituras = [];
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^SELECT phone FROM customers WHERE phone = \$1/.test(sql)) return { rows: cliente ? [{ phone: cliente.phone }] : [] };
        if (/^SELECT \* FROM customers WHERE phone = \$1/.test(sql)) return { rows: cliente ? [{ ...cliente }] : [] };
        if (/SELECT \* FROM operations\s+WHERE phone = \$1\s+ORDER BY id DESC LIMIT 1/.test(sql)) {
            return { rows: operaciones.filter(o => o.phone === params[0]).sort((a, b) => b.id - a.id).slice(0, 1) };
        }
        if (/^\s*(UPDATE|DELETE FROM|INSERT INTO) operations\b/i.test(sql)) escrituras.push(sql);
        return { rows: [] };
    });
    return { escrituras };
}

async function decir(phone, texto) {
    const desde = enviados.length;
    let resultado = "respondido";
    await procesarMensaje(phone, texto, "Cliente", null, { onResultado: r => { resultado = r; } });
    return { msgs: enviados.slice(desde).map(m => m.msg), resultado };
}

const PH = "5511900094001";
const CLIENTE = { phone: PH, saludo_enviado: true };
const op = (status, extra = {}) => ({ id: 55, phone: PH, monto: 300, cup: 51000, tipo: "brl_cup", status, ...extra });

test.beforeEach(() => { enviados = []; llamadasGPT = 0; });

test("esConsultaEstadoOperacion: seguimiento natural de una operación propia (ES)", () => {
    for (const f of ["Cuál es el estado de mi envío", "cómo va mi envío", "mi transferencia ya salió", "qué pasó con mi operación",
        "ya llegó mi dinero?", "cuándo llega mi remesa", "hay novedades de mi pedido", "cómo sigue mi transferencia"])
        assert.equal(esConsultaEstadoOperacion(norm(f)), true, f);
});

test("esConsultaEstadoOperacion: preguntas generales o ajenas NO son seguimiento", () => {
    for (const f of ["cómo estás", "cómo va todo", "cuál es la tasa hoy", "mi mamá está bien", "quiero hacer un envío", "cómo está el cambio", "cuánto demora un envío"])
        assert.equal(esConsultaEstadoOperacion(norm(f)), false, f);
});

for (const frase of ["Cuál es el estado de mi envío", "cómo va mi envío", "mi transferencia ya salió", "qué pasó con mi operación"]) {
    test(`"${frase}" con operación PENDIENTE real -> responde su estado real (ya no queda en silencio)`, async (t) => {
        const w = mundo(t, { cliente: CLIENTE, operaciones: [op("pendiente")] });
        const { msgs, resultado } = await decir(PH, frase);
        assert.deepEqual(msgs, ["Tu última operación: R$300 — ⏳ Pendiente de verificar"]);
        assert.equal(resultado, "respondido");
        assert.equal(llamadasGPT, 0);
        assert.deepEqual(w.escrituras, [], "solo lectura");
    });
}

test("estado real: confirmada se informa tal cual", async (t) => {
    mundo(t, { cliente: CLIENTE, operaciones: [op("confirmada")] });
    assert.deepEqual((await decir(PH, "cómo va mi envío")).msgs, ["Tu última operación: R$300 — ✅ Confirmada, en proceso"]);
});

test("estado real: completada se informa tal cual", async (t) => {
    mundo(t, { cliente: CLIENTE, operaciones: [op("completada")] });
    assert.deepEqual((await decir(PH, "cómo va mi envío")).msgs, ["Tu última operación: R$300 — 🎉 Completada"]);
});

test("no inventa estados: una operación expirada NO se informa como pendiente", async (t) => {
    mundo(t, { cliente: CLIENTE, operaciones: [op("expirada")] });
    const { msgs } = await decir(PH, "qué pasó con mi operación");
    assert.equal(msgs.length, 1);
    assert.doesNotMatch(msgs[0], /Pendiente/);
    assert.match(msgs[0], /Expirada/);
});

test("sin operación real -> lo dice (flujo existente), sin inventar", async (t) => {
    mundo(t, { cliente: CLIENTE, operaciones: [] });
    const { msgs } = await decir(PH, "cuál es el estado de mi envío");
    assert.deepEqual(msgs, ["No encuentro operaciones registradas 🤔\n\n¿Quieres hacer un envío?"]);
});

test("sin operación real pero con COTIZACIÓN en curso -> no la presenta como operación: retoma la cotización", async (t) => {
    mundo(t, { cliente: { ...CLIENTE, estado: "cotizacion_realizada", ultimo_monto: 420, tipo_favorito: "brl_cup",
        tarjeta_frecuente: "9205129912345678", fecha_cotizacion: new Date(AHORA - 10 * 60 * 1000).toISOString() }, operaciones: [] });
    const { msgs } = await decir(PH, "cómo va mi envío");
    assert.equal(msgs.length, 1);
    assert.doesNotMatch(msgs[0], /Tu última operación|Pendiente de verificar/);
    assert.match(msgs[0], /R\$420/);
});

test("mensajes ajenos al negocio siguen en silencio (no abre conversación general)", async (t) => {
    mundo(t, { cliente: CLIENTE });
    for (const f of ["cómo va todo", "mi mamá está bien, gracias a dios"]) {
        const { msgs, resultado } = await decir(PH, f);
        assert.deepEqual(msgs, [], f);
        assert.equal(resultado, "porton", f);
    }
    assert.equal(llamadasGPT, 0);
});
