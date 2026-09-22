"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — recordatorios CRM (onda 30m/24h/7d) nunca le
// escriben a un número bloqueado (src/services/crm.js).
//
// Reemplaza zapi.js ANTES de cargar crm.js para no depender de red real y
// poder contar exactamente a qué teléfonos se les intentó enviar algo.
// ─────────────────────────────────────────────────────────

let mensajesEnviados = [];
const zapiPath = require.resolve("../src/services/zapi");
require.cache[zapiPath] = {
    id: zapiPath, filename: zapiPath, loaded: true,
    exports: {
        enviarMensaje: async (phone, msg) => { mensajesEnviados.push(phone); return true; },
        enviarImagen: async () => {},
        enviarConDelay: async (phone) => { mensajesEnviados.push(phone); },
        mostrarEscribiendo: async () => {},
        calcularDelay: () => 0
    }
};

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const crm = require("../src/services/crm");

test.beforeEach(() => { mensajesEnviados = []; });

function mockOnda30min(t, { bloqueados = [], pausas = {} } = {}) {
    const bloqueadosSet = new Set(bloqueados);
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/FROM customers\s+WHERE estado_crm = 'cotizado'/.test(sql)) {
            return {
                rows: [
                    { phone: "5511900000001", nombre: "Bloqueado", ultimo_monto: 300, idioma: "es" },
                    { phone: "5511900000002", nombre: "Normal", ultimo_monto: 300, idioma: "es" }
                ]
            };
        }
        if (/^SELECT 1 FROM blocked_numbers WHERE phone = \$1/.test(sql)) {
            return { rows: bloqueadosSet.has(params[0]) ? [{ "?column?": 1 }] : [] };
        }
        if (/^SELECT pausa_hasta FROM customers WHERE phone = \$1/.test(sql)) {
            return { rows: [{ pausa_hasta: pausas[params[0]] || null }] };
        }
        return { rows: [] };
    });
}

// ── PAUSA HUMANA — mismo mecanismo que entregas-avisos.js
// (webhook-guard.js:enPausaHumana), ahora también respetado por los 3
// recordatorios automáticos del CRM. ──

test("onda30min: pausa humana ACTIVA -> no envía el recordatorio", async (t) => {
    const enUnaHora = new Date(Date.now() + 60 * 60000).toISOString();
    mockOnda30min(t, { pausas: { "5511900000002": enUnaHora } });
    await crm.ejecutarRecordatorios();
    assert.ok(!mensajesEnviados.includes("5511900000002"), "con pausa_hasta en el futuro, el recordatorio no debe enviarse");
});

test("onda30min: pausa humana VENCIDA -> comportamiento normal (sí envía)", async (t) => {
    const haceUnaHora = new Date(Date.now() - 60 * 60000).toISOString();
    mockOnda30min(t, { pausas: { "5511900000002": haceUnaHora } });
    await crm.ejecutarRecordatorios();
    assert.ok(mensajesEnviados.includes("5511900000002"), "con pausa_hasta ya vencida, el recordatorio debe enviarse igual que siempre");
});

test("onda30min: SIN pausa (pausa_hasta null) -> comportamiento normal (sí envía)", async (t) => {
    mockOnda30min(t, {});
    await crm.ejecutarRecordatorios();
    assert.ok(mensajesEnviados.includes("5511900000002"));
});

test("onda30min: nunca envía el recordatorio a un número bloqueado", async (t) => {
    mockOnda30min(t, { bloqueados: ["5511900000001"] });
    await crm.ejecutarRecordatorios();
    assert.ok(!mensajesEnviados.includes("5511900000001"), "el bloqueado no debe recibir el recordatorio de 30 min");
    assert.ok(mensajesEnviados.includes("5511900000002"), "el cliente normal sí debe recibirlo");
});

function mockOnda24h(t, { bloqueados = [], pausas = {} } = {}) {
    const bloqueadosSet = new Set(bloqueados);
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/estado_crm IN \('cotizado', 'esperando_pix'\)/.test(sql)) {
            return {
                rows: [
                    { phone: "5511900000003", nombre: "Bloqueado", idioma: "es" },
                    { phone: "5511900000004", nombre: "Normal", idioma: "es" }
                ]
            };
        }
        if (/^SELECT 1 FROM blocked_numbers WHERE phone = \$1/.test(sql)) {
            return { rows: bloqueadosSet.has(params[0]) ? [{ "?column?": 1 }] : [] };
        }
        if (/^SELECT pausa_hasta FROM customers WHERE phone = \$1/.test(sql)) {
            return { rows: [{ pausa_hasta: pausas[params[0]] || null }] };
        }
        return { rows: [] };
    });
}

test("onda24h: nunca envía el recordatorio a un número bloqueado", async (t) => {
    mockOnda24h(t, { bloqueados: ["5511900000003"] });
    await crm.ejecutarRecordatorios();
    assert.ok(!mensajesEnviados.includes("5511900000003"));
    assert.ok(mensajesEnviados.includes("5511900000004"));
});

test("onda24h: pausa humana ACTIVA -> no envía el recordatorio", async (t) => {
    const enUnaHora = new Date(Date.now() + 60 * 60000).toISOString();
    mockOnda24h(t, { pausas: { "5511900000004": enUnaHora } });
    await crm.ejecutarRecordatorios();
    assert.ok(!mensajesEnviados.includes("5511900000004"));
});

function mockOnda7d(t, { bloqueados = [], pausas = {} } = {}) {
    const bloqueadosSet = new Set(bloqueados);
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/estado_crm = 'abandono'/.test(sql)) {
            return {
                rows: [
                    { phone: "5511900000005", nombre: "Bloqueado", idioma: "es" },
                    { phone: "5511900000006", nombre: "Normal", idioma: "es" }
                ]
            };
        }
        if (/^SELECT 1 FROM blocked_numbers WHERE phone = \$1/.test(sql)) {
            return { rows: bloqueadosSet.has(params[0]) ? [{ "?column?": 1 }] : [] };
        }
        if (/^SELECT pausa_hasta FROM customers WHERE phone = \$1/.test(sql)) {
            return { rows: [{ pausa_hasta: pausas[params[0]] || null }] };
        }
        return { rows: [] };
    });
}

test("onda7d: nunca envía el recordatorio a un número bloqueado", async (t) => {
    mockOnda7d(t, { bloqueados: ["5511900000005"] });
    await crm.ejecutarRecordatorios();
    assert.ok(!mensajesEnviados.includes("5511900000005"));
    assert.ok(mensajesEnviados.includes("5511900000006"));
});

test("onda7d: pausa humana ACTIVA -> no envía el recordatorio", async (t) => {
    const enUnaHora = new Date(Date.now() + 60 * 60000).toISOString();
    mockOnda7d(t, { pausas: { "5511900000006": enUnaHora } });
    await crm.ejecutarRecordatorios();
    assert.ok(!mensajesEnviados.includes("5511900000006"));
});
