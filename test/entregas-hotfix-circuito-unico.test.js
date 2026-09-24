"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../db");
const operations = require("../src/services/operations");
const entregas = require("../src/services/entregas");
const { finalizarEntrega } = require("../src/services/entregas-coordinator");
const { mensajeCompletarOperacion } = require("../src/services/operation-messages");
const env = require("../src/config/env");
const { destinatariosInternosEntregas } = require("../src/flows/shared");

test("Transferencia exige operador para aplicar el saldo antes de completarse", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [{ id: 1, tipo: "brl_cup", status: "confirmada" }] }));
    const op = await operations.completarOperacion(1);
    assert.deepEqual(op, { error: "Selecciona el operador asignado" });
});

test("Recarga conserva su transición general y su mensaje propio", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [{ id: 2, tipo: "recarga_nacional", status: "completada" }] }));
    const op = await operations.completarOperacion(2);
    assert.equal(op.status, "completada");
    assert.match(mensajeCompletarOperacion(op), /recarga Nacional fue completada/i);
});

test("Entrega no puede completarse por el circuito general", async (t) => {
    let sql = "";
    t.mock.method(pool, "query", async (q) => { sql = q; return { rows: [] }; });
    assert.equal(await operations.completarOperacion(3), null);
    assert.match(sql, /tipo NOT IN \('cup_efectivo', 'usd_efectivo'\)/);
    assert.equal(mensajeCompletarOperacion({ tipo: "cup_efectivo" }), null);
});

test("ENTREGADO sincroniza operation en la misma transacción y deja de ser elegible para avisos", async (t) => {
    const sqls = [];
    const entrega = { id: 10, codigo: "E-1010", operation_id: 33, phone: "5511999", estado_entrega: "ENTREGADO" };
    t.mock.method(pool, "connect", async () => ({
        query: async (sql) => {
            sqls.push(sql);
            if (/UPDATE entregas/.test(sql)) return { rows: [entrega] };
            return { rows: [] };
        }, release() {}
    }));
    const r = await entregas.marcarEntregado(10, "Panel");
    assert.equal(r.estado_entrega, "ENTREGADO");
    assert.ok(sqls.some(s => /UPDATE operations[\s\S]*status = 'completada'/.test(s)));
    assert.ok(sqls.includes("BEGIN") && sqls.includes("COMMIT"));
    assert.match(entregas.obtenerEntregasPendientesParaAviso.toString(), /estado_entrega = 'PENDIENTE'/);
});

const ENTREGA_BASE = { id: 10, codigo: "E-1010", phone: "5511999", receptor_nombre: "Dayron", cantidad: 50, moneda: "USD" };

function depsFinalizar({ entrega = ENTREGA_BASE, internos = [] } = {}) {
    let transiciones = 0;
    const mensajes = [];
    const deps = {
        marcarEntregado: async () => (++transiciones === 1 ? entrega : null),
        enviarSeguro: async (phone, msg) => { mensajes.push({ phone, msg }); return true; },
        destinatariosInternosEntregas: () => internos
    };
    return { deps, mensajes, getTransiciones: () => transiciones };
}

test("coordinador envía exactamente un mensaje final al cliente; retry/doble click no duplica ni el mensaje al cliente ni el aviso interno", async () => {
    const { deps, mensajes } = depsFinalizar({ internos: ["5533111", "5491179017718"] });
    assert.ok(await finalizarEntrega(10, "Panel", deps));
    assert.equal(await finalizarEntrega(10, "Panel", deps), null); // retry: ya no está PENDIENTE
    assert.equal(mensajes.filter(m => m.phone === "5511999").length, 1);
    assert.match(mensajes.find(m => m.phone === "5511999").msg, /entrega E-1010 fue completada/i);
    assert.equal(mensajes.length, 3); // 1 cliente + 2 internos (ADMIN + contacto), ninguno repetido por el retry
});

test("ADMIN_PHONE y ENTREGA_CONTACT_PHONE diferentes -> 2 avisos internos, uno a cada uno, con el formato operativo", async () => {
    const { deps, mensajes } = depsFinalizar({ internos: ["5533111", "5491179017718"] });
    await finalizarEntrega(10, "Panel", deps);
    const internos = mensajes.filter(m => m.phone !== "5511999");
    assert.equal(internos.length, 2);
    assert.deepEqual(internos.map(m => m.phone).sort(), ["5491179017718", "5533111"]);
    for (const m of internos) {
        assert.equal(
            m.msg,
            "✅ Entrega E-1010 marcada como ENTREGADO.\n\n👤 *Receptor:* Dayron\n💵 *Entregado:* 50 USD\n\n💵 *Pago al contacto:* PENDIENTE DE PAGO"
        );
    }
});

test("ADMIN_PHONE y ENTREGA_CONTACT_PHONE equivalentes (mismos dígitos, formato distinto) -> 1 solo aviso interno", async () => {
    // destinatariosInternosEntregas() ya deduplica antes de llegar acá --
    // se simula pasando la lista YA deduplicada, como lo haría la real.
    const { deps, mensajes } = depsFinalizar({ internos: ["+55 33 1111-1111"] });
    await finalizarEntrega(10, "Panel", deps);
    const internos = mensajes.filter(m => m.phone !== "5511999");
    assert.equal(internos.length, 1);
});

test("el mensaje interno nunca se manda al cliente (entrega.phone) ni al receptor (telefono_entrega)", async () => {
    const entrega = { ...ENTREGA_BASE, telefono_entrega: "53599999" };
    const { deps, mensajes } = depsFinalizar({ entrega, internos: ["5533111"] });
    await finalizarEntrega(10, "Panel", deps);
    assert.equal(mensajes.filter(m => m.phone === "53599999").length, 0);
    const alCliente = mensajes.filter(m => m.phone === "5511999");
    assert.equal(alCliente.length, 1);
    assert.match(alCliente[0].msg, /completada/i); // el mensaje al cliente, nunca el interno
});

test("fallo al notificar UN destinatario interno no duplica el otro ni afecta el mensaje del cliente ni revierte ENTREGADO", async () => {
    const entrega = ENTREGA_BASE;
    const mensajes = [];
    let transiciones = 0;
    const deps = {
        marcarEntregado: async () => (++transiciones === 1 ? entrega : null),
        enviarSeguro: async (phone, msg) => {
            if (phone === "5533111") throw new Error("Z-API caído para este número");
            mensajes.push({ phone, msg });
            return true;
        },
        destinatariosInternosEntregas: () => ["5533111", "5491179017718"]
    };
    const r = await finalizarEntrega(10, "Panel", deps);
    assert.equal(r.entrega.estado_entrega === "CANCELADO", false, "la transición ENTREGADO no se revierte por un fallo de WhatsApp");
    assert.equal(r.notificado, true, "el mensaje al cliente sí se pudo enviar");
    assert.equal(mensajes.filter(m => m.phone === "5511999").length, 1);
    assert.equal(mensajes.filter(m => m.phone === "5491179017718").length, 1, "el otro destinatario interno igual recibe su aviso");
    assert.equal(mensajes.filter(m => m.phone === "5533111").length, 0);
});

test("fallo del admin no impide el aviso al contacto y deja ambos resultados auditables sin teléfono completo", async () => {
    const lineas = [];
    const errores = [];
    const original = console.log;
    const originalError = console.error;
    console.log = linea => lineas.push(linea);
    console.error = linea => errores.push(String(linea));
    try {
        const deps = {
            marcarEntregado: async () => ENTREGA_BASE,
            enviarSeguro: async (phone) => phone === "5533111" ? false : true,
            destinatariosInternosEntregas: () => ["5533111", "5491179017718"]
        };
        await finalizarEntrega(10, "Panel", deps);
    } finally { console.log = original; console.error = originalError; }
    const avisos = lineas.map(x => { try { return JSON.parse(x); } catch { return null; } })
        .filter(x => x?.evento === "DELIVERY_INTERNAL_NOTIFICATION");
    assert.deepEqual(avisos.map(x => [x.rol, x.resultado]), [["ADMIN", "FALLO"], ["ENTREGA_CONTACT", "EXITO"]]);
    assert.ok(avisos.every(x => !x.phone.includes("5533111") && !x.phone.includes("5491179017718")));
    assert.ok(errores.every(x => !x.includes("5533111") && !x.includes("5491179017718")));
});

test("sin ENTREGA_CONTACT_PHONE no usa fallback y solo conserva al admin", () => {
    const anterior = env.ENTREGA_CONTACT_PHONE;
    try {
        env.ADMIN_PHONE = "5533111";
        env.ENTREGA_CONTACT_PHONE = null;
        assert.deepEqual(destinatariosInternosEntregas(), ["5533111"]);
    } finally { env.ENTREGA_CONTACT_PHONE = anterior; }
});

test("CANCELADO sincroniza la operation como rechazada y queda fuera de avisos pendientes", async (t) => {
    const sqls = [];
    t.mock.method(pool, "connect", async () => ({
        query: async (sql) => {
            sqls.push(sql);
            if (/UPDATE entregas/.test(sql)) return { rows: [{ id: 11, codigo: "E-1011", operation_id: 34, estado_entrega: "CANCELADO" }] };
            return { rows: [] };
        }, release() {}
    }));
    const r = await entregas.marcarCancelado(11, "cancelada");
    assert.equal(r.estado_entrega, "CANCELADO");
    assert.ok(sqls.some(s => /UPDATE operations[\s\S]*status = 'rechazada'/.test(s)));
    assert.match(entregas.obtenerEntregasPendientesParaAviso.toString(), /estado_entrega = 'PENDIENTE'/);
});
