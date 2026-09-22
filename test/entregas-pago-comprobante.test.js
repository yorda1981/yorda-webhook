"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mensajeComprobantePago, notificarComprobantePago } = require("../src/services/entregas-coordinator");

const resultado = {
    pago: { id: 8, codigo: "P-008", fecha: "2026-09-22", subtotal_usdt: 150, frete_usdt: 5, total_usdt: 155 },
    entregas: [{ codigo: "E-1000" }, { codigo: "E-1001" }]
};

test("comprobante de pago usa subtotal + frete = total persistidos y una sola pieza por pago", () => {
    const msg = mensajeComprobantePago(resultado);
    assert.match(msg, /P-008/);
    assert.match(msg, /2026-09-22/);
    assert.match(msg, /E-1000, E-1001/);
    assert.match(msg, /Cantidad:\* 2/);
    assert.match(msg, /Subtotal entregas:\* 150 USDT/);
    assert.match(msg, /Frete:\* 5 USDT/);
    assert.match(msg, /TOTAL PAGADO:\* 155 USDT/);
    assert.match(msg, /Estado: PAGADO/);
});

function deps({ fallarRol } = {}) {
    const enviados = [];
    return {
        enviados,
        deps: {
            destinatariosInternosEntregasDetallados: () => [
                { phone: "5533111", rol: "ADMIN" },
                { phone: "5491179017718", rol: "ENTREGA_CONTACT" }
            ],
            enviarSeguro: async (phone, msg) => {
                const rol = phone === "5533111" ? "ADMIN" : "ENTREGA_CONTACT";
                enviados.push({ phone, msg, rol });
                if (rol === fallarRol) return false;
                return true;
            }
        }
    };
}

test("comprobante se envía una sola vez a ADMIN y ENTREGA_CONTACT, nunca al cliente", async () => {
    const d = deps();
    await notificarComprobantePago(resultado, d.deps);
    assert.deepEqual(d.enviados.map(x => x.rol), ["ADMIN", "ENTREGA_CONTACT"]);
    assert.equal(d.enviados.length, 2);
    assert.ok(d.enviados.every(x => !x.phone.includes("5511999")));
    assert.equal(d.enviados[0].msg, d.enviados[1].msg);
});

test("fallo de ADMIN no impide el intento a ENTREGA_CONTACT", async () => {
    const d = deps({ fallarRol: "ADMIN" });
    await notificarComprobantePago(resultado, d.deps);
    assert.deepEqual(d.enviados.map(x => x.rol), ["ADMIN", "ENTREGA_CONTACT"]);
});

test("fallo de ENTREGA_CONTACT no repite ADMIN ni altera el pago", async () => {
    const d = deps({ fallarRol: "ENTREGA_CONTACT" });
    await notificarComprobantePago(resultado, d.deps);
    assert.deepEqual(d.enviados.map(x => x.rol), ["ADMIN", "ENTREGA_CONTACT"]);
    assert.equal(resultado.pago.total_usdt, 155);
});

test("pago histórico sin subtotal/total no genera comprobante falso", async () => {
    const d = deps();
    await notificarComprobantePago({ pago: { codigo: "P-001", subtotal_usdt: null, total_usdt: null }, entregas: [{ codigo: "E-1" }] }, d.deps);
    assert.equal(d.enviados.length, 0);
});
