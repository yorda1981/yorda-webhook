"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — Oferta general / VIP (src/flows/cotizacion-flow.js,
// leerOferta). Esta lógica YA estaba implementada correctamente antes de
// esta fase (prioridad VIP, chequeo de vencimiento) -- estas pruebas
// documentan y protegen ese comportamiento como contrato explícito.
// ─────────────────────────────────────────────────────────

const zapiPath = require.resolve("../src/services/zapi");
require.cache[zapiPath] = {
    id: zapiPath, filename: zapiPath, loaded: true,
    exports: {
        enviarMensaje: async () => true, enviarImagen: async () => {},
        enviarConDelay: async () => {}, mostrarEscribiendo: async () => {}, calcularDelay: () => 0
    }
};

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const { leerOferta } = require("../src/flows/cotizacion-flow");

function mockOferta(t, oferta) {
    t.mock.method(pool, "query", async (sql) => {
        if (/^SELECT \* FROM ofertas LIMIT 1/.test(sql)) return { rows: oferta ? [oferta] : [] };
        return { rows: [] };
    });
}

function enHoras(h) { return new Date(Date.now() + h * 3600000).toISOString(); }

test("oferta general activa y no vencida -> se usa para un cliente no-VIP", async (t) => {
    mockOferta(t, { activa: true, texto: "R$500+ recibe 140 CUP", vence_at: enHoras(2), activa_vip: false, texto_vip: null });
    const r = await leerOferta(false);
    assert.equal(r, "R$500+ recibe 140 CUP");
});

test("oferta general activa pero VENCIDA -> no se ofrece", async (t) => {
    mockOferta(t, { activa: true, texto: "R$500+ recibe 140 CUP", vence_at: enHoras(-2), activa_vip: false, texto_vip: null });
    const r = await leerOferta(false);
    assert.equal(r, null, "una oferta marcada activa pero vencida no puede seguir ofreciéndose");
});

test("oferta general DESACTIVADA (aunque no esté vencida) -> no se ofrece", async (t) => {
    mockOferta(t, { activa: false, texto: "R$500+ recibe 140 CUP", vence_at: enHoras(5), activa_vip: false, texto_vip: null });
    const r = await leerOferta(false);
    assert.equal(r, null);
});

test("oferta general sin fecha de vencimiento (vence_at null) + activa -> se ofrece indefinidamente", async (t) => {
    mockOferta(t, { activa: true, texto: "R$500+ recibe 140 CUP", vence_at: null, activa_vip: false, texto_vip: null });
    const r = await leerOferta(false);
    assert.equal(r, "R$500+ recibe 140 CUP");
});

test("VIP con oferta VIP activa -> usa la oferta VIP en vez de la general", async (t) => {
    mockOferta(t, {
        activa: true, texto: "Oferta general", vence_at: enHoras(2),
        activa_vip: true, texto_vip: "Oferta exclusiva VIP: entrega gratis"
    });
    const r = await leerOferta(true);
    assert.equal(r, "Oferta exclusiva VIP: entrega gratis");
});

test("VIP sin oferta VIP activa -> cae a la oferta general si está activa y vigente", async (t) => {
    mockOferta(t, { activa: true, texto: "Oferta general", vence_at: enHoras(2), activa_vip: false, texto_vip: "Nunca se usa" });
    const r = await leerOferta(true);
    assert.equal(r, "Oferta general");
});

test("VIP con oferta VIP marcada activa pero SIN texto -> cae a la oferta general", async (t) => {
    mockOferta(t, { activa: true, texto: "Oferta general", vence_at: enHoras(2), activa_vip: true, texto_vip: null });
    const r = await leerOferta(true);
    assert.equal(r, "Oferta general");
});

test("no VIP y ninguna oferta configurada -> null (usa tasas/reglas normales)", async (t) => {
    mockOferta(t, null);
    const r = await leerOferta(false);
    assert.equal(r, null);
});

test("no interpreta el texto promocional para calcular nada -- se devuelve tal cual, sin parsear", async (t) => {
    mockOferta(t, { activa: true, texto: "R$500+ recibe 140 CUP extra, aplica desde el 1/1", vence_at: null, activa_vip: false, texto_vip: null });
    const r = await leerOferta(false);
    assert.equal(r, "R$500+ recibe 140 CUP extra, aplica desde el 1/1");
});
