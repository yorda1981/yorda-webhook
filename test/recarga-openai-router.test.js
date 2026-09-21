"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — dispatch de Recargas dentro del router principal
// (src/services/openai.js: procesarMensaje). Complementa test/recarga-
// dinamica.test.js (que prueba las funciones de src/flows/recarga-flow.js
// de forma aislada) verificando que el CABLEADO real -- selección natural
// directa, cambios de modalidad/número, cancelación y confirmación del
// resumen -- funciona end-to-end a través del router determinista, sin
// ampliar los gatillos globales del bot (mismo patrón que
// test/conversacion-humanizacion.test.js).
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
const HORA_ATENCION_FIJA = new Date("2026-01-15T17:00:00.000Z").getTime(); // 14:00 en Brasil (UTC-3)

const NACIONAL = { tipo: "nacional", precio: 100, descripcion: "2.000 CUP", activa: true };
const INTERNACIONAL = { tipo: "internacional", precio: 145, descripcion: "600 CUP x6", activa: true };

function mockMundo(t, { recargasActivas = [NACIONAL, INTERNACIONAL] } = {}) {
    t.mock.timers.enable({ apis: ["Date"], now: HORA_ATENCION_FIJA });
    const customers = new Map();

    function aplicarParams(row, params) {
        const set = (i, col) => { if (params[i] != null) row[col] = params[i]; };
        set(1, "nombre"); set(2, "ultimo_monto"); set(3, "tipo_favorito"); set(4, "banco_favorito");
        set(5, "tarjeta_frecuente"); set(6, "titular_frecuente"); set(7, "banco_detectado");
        set(8, "estado"); set(9, "fecha_estado"); set(10, "fecha_cotizacion"); set(11, "fecha_pix");
        set(13, "comprobante_pendiente"); set(14, "valor_comprobante");
        set(19, "ultima_pregunta");
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

        if (/^SELECT \* FROM rates LIMIT 1/.test(sql)) return { rows: [TASAS_DEFAULT] };
        if (/^SELECT \* FROM ofertas LIMIT 1/.test(sql)) return { rows: [] };
        if (/^SELECT 1 FROM blocked_numbers WHERE phone = \$1/.test(sql)) return { rows: [] };
        if (/^SELECT \* FROM operations WHERE\s+phone = \$1 AND status = 'pendiente'/.test(sql)) return { rows: [] };
        if (/^SELECT id FROM operations WHERE phone = \$1 AND status = 'pendiente' AND monto = \$2/.test(sql)) return { rows: [] };

        if (/SELECT \* FROM recargas[\s\S]*WHERE activa = true/.test(sql)) return { rows: recargasActivas };
        if (/SELECT descripcion, precio FROM recargas WHERE tipo = \$1 LIMIT 1/.test(sql)) {
            const r = recargasActivas.find(x => x.tipo === params[0]);
            return { rows: r ? [{ descripcion: r.descripcion, precio: r.precio }] : [] };
        }

        return { rows: [] };
    });

    return { customers };
}

test.beforeEach(() => { cuentaLlamadasGPT = 0; mensajesEnviados = []; });

test("'quiero una recarga internacional' (sin estado previo) selecciona DIRECTO Internacional, sin pasar por el menú de dos opciones", async (t) => {
    const mundo = mockMundo(t);
    await procesarMensaje("5511900060001", "quiero una recarga internacional", "Cliente");
    const row = mundo.customers.get("5511900060001");
    assert.equal(row.tipo_favorito, "recarga_internacional");
    assert.equal(row.estado, "aguardando_numero_recarga");
    assert.equal(cuentaLlamadasGPT, 0);
});

test("estando en 'confirmando_recarga', 'mejor la nacional' cambia de modalidad y vuelve a pedir el número", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900060002", {
        phone: "5511900060002", tipo_favorito: "recarga_internacional", tarjeta_frecuente: "51234567", estado: "confirmando_recarga"
    });
    await procesarMensaje("5511900060002", "mejor la nacional", "Cliente");
    const row = mundo.customers.get("5511900060002");
    assert.equal(row.tipo_favorito, "recarga_nacional");
    assert.equal(row.estado, "aguardando_numero_recarga");
});

test("estando en 'aguardando_numero_recarga', 'cancela' limpia la sesión sin tocar operations", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900060003", {
        phone: "5511900060003", tipo_favorito: "recarga_nacional", estado: "aguardando_numero_recarga"
    });
    const r = await procesarMensaje("5511900060003", "cancela", "Cliente");
    assert.match(r, /cancelé la recarga/i);
    const row = mundo.customers.get("5511900060003");
    assert.equal(row.estado, null);
    assert.equal(row.tipo_favorito, null);
});

test("estando en 'confirmando_recarga', 'sí' confirma el resumen y avanza a 'aguardando_comprovante' (PIX)", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900060004", {
        phone: "5511900060004", tipo_favorito: "recarga_nacional", tarjeta_frecuente: "51234567", estado: "confirmando_recarga"
    });
    await procesarMensaje("5511900060004", "si", "Cliente");
    const row = mundo.customers.get("5511900060004");
    assert.equal(row.estado, "aguardando_comprovante");
});

test("estando en 'seleccionando_recarga' con dos opciones, el nombre ('nacional') selecciona esa modalidad", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900060005", { phone: "5511900060005", estado: "seleccionando_recarga" });
    await procesarMensaje("5511900060005", "nacional", "Cliente");
    const row = mundo.customers.get("5511900060005");
    assert.equal(row.tipo_favorito, "recarga_nacional");
    assert.equal(row.estado, "aguardando_numero_recarga");
});

test("estando en 'confirmando_recarga', un mensaje que no confirma ni es una acción reconocida -- vuelve a pedir confirmación, nunca en silencio", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900060006", {
        phone: "5511900060006", tipo_favorito: "recarga_nacional", tarjeta_frecuente: "51234567", estado: "confirmando_recarga"
    });
    const r = await procesarMensaje("5511900060006", "mmm no se", "Cliente");
    assert.notEqual(r, "");
    assert.match(r, /confirmamos la recarga/i);
    const row = mundo.customers.get("5511900060006");
    assert.equal(row.estado, "confirmando_recarga", "no debe avanzar a PIX sin confirmación explícita");
});
