"use strict";

// env.js lee process.env.ADMIN_PHONE UNA sola vez al cargarse -- tiene que
// quedar seteada antes del primer require de cualquier módulo que dependa
// de ella (mismo criterio que test/pix-flow-comprobante-admin.test.js).
process.env.ADMIN_PHONE = "5511900000999";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — formato visual (emoji + negrita) de los mensajes
// de WhatsApp del CRM de Entregas. Mismo criterio ya aprobado para
// Operadores de Transferencias (test/operadores.test.js) -- SOLO
// presentación: ningún dato/cálculo/estado/lógica de Entregas cambia.
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

const { notificarNuevaEntrega } = require("../src/flows/pedido-web-flow");
const { mensajeEntregaMarcada } = require("../src/services/entregas");

test.beforeEach(() => { mensajesEnviados = []; });

const ENTREGA_COMPLETA = {
    codigo: "E-1050", cliente_nombre: "Ana García", phone: "5511900010001",
    telefono_entrega: "53555512345", cantidad: 20130, moneda: "CUP",
    provincia: "La Habana", municipio: "Playa", direccion: "Calle 23 #456",
    referencia: "Casa azul", observaciones: null
};

test("notificarNuevaEntrega: usa el mismo criterio visual aprobado para Operadores (emoji + negrita, un icono por dato)", async () => {
    await notificarNuevaEntrega(ENTREGA_COMPLETA);
    const msg = mensajesEnviados[0].msg;
    assert.match(msg, /👤 \*Cliente:\* Ana García/);
    assert.match(msg, /📞 \*Teléfono:\* 53555512345/);
    assert.match(msg, /💵 \*Entregar:\* 20\.130 CUP/);
    assert.match(msg, /📍 \*Lugar:\* La Habana, Playa/);
    assert.match(msg, /📍 \*Dirección:\* Calle 23 #456/);
});

test("notificarNuevaEntrega: usa 💵 (efectivo), nunca 💰 -- el CRM de Entregas es siempre efectivo por diseño", async () => {
    await notificarNuevaEntrega(ENTREGA_COMPLETA);
    const msg = mensajesEnviados[0].msg;
    assert.doesNotMatch(msg, /💰/);
});

test("notificarNuevaEntrega: no agrega ningún dato nuevo -- mismos campos que antes, solo con icono", async () => {
    await notificarNuevaEntrega(ENTREGA_COMPLETA);
    const msg = mensajesEnviados[0].msg;
    assert.match(msg, /E-1050/);
    assert.match(msg, /Referencia: Casa azul/); // sin ícono -- no estaba en la lista pedida
    assert.match(msg, /Estado: PENDIENTE/);
});

test("notificarNuevaEntrega: sin dirección -- no inventa la línea (el dato simplemente no existe)", async () => {
    await notificarNuevaEntrega({ ...ENTREGA_COMPLETA, direccion: null });
    const msg = mensajesEnviados[0].msg;
    assert.doesNotMatch(msg, /Dirección/);
});

test("notificarNuevaEntrega: se envía tanto al admin como al contacto de entrega, con el mismo formato", async () => {
    await notificarNuevaEntrega(ENTREGA_COMPLETA);
    assert.equal(mensajesEnviados.length, 2);
    assert.equal(mensajesEnviados[0].msg, mensajesEnviados[1].msg);
});

// ── mensajeEntregaMarcada (aviso al admin al marcar ENTREGADO) ──

test("mensajeEntregaMarcada: mismo criterio visual -- 👤 Cliente, 💵 Entregado, 💵 Pago al contacto", () => {
    const msg = mensajeEntregaMarcada({ codigo: "E-1050", cliente_nombre: "Ana García", cantidad: 20130, moneda: "CUP" });
    assert.equal(
        msg,
        "✅ Entrega E-1050 marcada como ENTREGADO.\n\n👤 *Cliente:* Ana García\n💵 *Entregado:* 20.130 CUP\n\n💵 *Pago al contacto:* PENDIENTE DE PAGO"
    );
});

test("mensajeEntregaMarcada: separador de miles solo visual, no altera el valor real de la entrega", () => {
    const entrega = { codigo: "E-1051", cliente_nombre: "Pedro", cantidad: 5000, moneda: "USD" };
    mensajeEntregaMarcada(entrega);
    assert.equal(entrega.cantidad, 5000, "el valor numérico original no debe modificarse");
    assert.equal(typeof entrega.cantidad, "number");
});
