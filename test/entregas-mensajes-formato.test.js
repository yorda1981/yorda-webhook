"use strict";

// env.js lee process.env.ADMIN_PHONE UNA sola vez al cargarse -- tiene que
// quedar seteada antes del primer require de cualquier módulo que dependa
// de ella (mismo criterio que test/pix-flow-comprobante-admin.test.js).
process.env.ADMIN_PHONE = "5511900000999";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — formato visual (emoji + negrita) de los mensajes
// de WhatsApp del CRM de Entregas, y el nombre del RECEPTOR (migración
// 0017, separado del cliente que paga). Mismo criterio ya aprobado para
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

const pool = require("../db");
const { notificarNuevaEntrega, procesarPedidoWeb } = require("../src/flows/pedido-web-flow");
const { mensajeEntregaMarcada, nombreReceptor } = require("../src/services/entregas");

test.beforeEach(() => { mensajesEnviados = []; });

const ENTREGA_COMPLETA = {
    codigo: "E-1050", cliente_nombre: "María Paga (cliente)", receptor_nombre: "Ana García (receptora)",
    phone: "5511900010001", telefono_entrega: "53555512345", cantidad: 20130, moneda: "CUP",
    provincia: "La Habana", municipio: "Playa", direccion: "Calle 23 #456",
    referencia: "Casa azul", observaciones: null
};

// ── nombreReceptor: resguardo para compatibilidad con entregas antiguas ──

test("nombreReceptor: usa receptor_nombre cuando existe (migración 0017)", () => {
    assert.equal(nombreReceptor(ENTREGA_COMPLETA), "Ana García (receptora)");
});

test("nombreReceptor: entregas antiguas sin receptor_nombre -- cae a cliente_nombre, nunca se rompe", () => {
    assert.equal(nombreReceptor({ cliente_nombre: "Ana García", receptor_nombre: null }), "Ana García");
    assert.equal(nombreReceptor({ cliente_nombre: "Ana García" }), "Ana García");
});

test("nombreReceptor: sin ningún nombre -- nunca inventa uno, usa un genérico fijo", () => {
    assert.equal(nombreReceptor({}), "Cliente");
});

// ── notificarNuevaEntrega ──

test("notificarNuevaEntrega: usa el receptor (no el cliente que paga) en la línea de Receptor", async () => {
    await notificarNuevaEntrega(ENTREGA_COMPLETA);
    const msg = mensajesEnviados[0].msg;
    assert.match(msg, /👤 \*Receptor:\* Ana García \(receptora\)/);
    assert.doesNotMatch(msg, /María Paga/, "el nombre del cliente que paga no debe aparecer en el aviso operativo de Entregas");
});

test("notificarNuevaEntrega: entrega SIN receptor_nombre (canal antiguo/calculadora) -- usa cliente_nombre como resguardo", async () => {
    const { receptor_nombre, ...sinReceptor } = ENTREGA_COMPLETA;
    await notificarNuevaEntrega(sinReceptor);
    const msg = mensajesEnviados[0].msg;
    assert.match(msg, /👤 \*Receptor:\* María Paga \(cliente\)/);
});

test("notificarNuevaEntrega: usa el mismo criterio visual aprobado para Operadores (emoji + negrita, un icono por dato)", async () => {
    await notificarNuevaEntrega(ENTREGA_COMPLETA);
    const msg = mensajesEnviados[0].msg;
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

test("mensajeEntregaMarcada: usa el receptor (con resguardo a cliente_nombre), 💵 Entregado, 💵 Pago al contacto", () => {
    const msg = mensajeEntregaMarcada({ codigo: "E-1050", cliente_nombre: "María Paga", receptor_nombre: "Ana García", cantidad: 20130, moneda: "CUP" });
    assert.equal(
        msg,
        "✅ Entrega E-1050 marcada como ENTREGADO.\n\n👤 *Receptor:* Ana García\n💵 *Entregado:* 20.130 CUP\n\n💵 *Pago al contacto:* PENDIENTE DE PAGO"
    );
});

test("mensajeEntregaMarcada: entrega antigua sin receptor_nombre -- usa cliente_nombre, nunca se rompe", () => {
    const msg = mensajeEntregaMarcada({ codigo: "E-1049", cliente_nombre: "Pedro", cantidad: 5000, moneda: "USD" });
    assert.match(msg, /👤 \*Receptor:\* Pedro/);
});

test("mensajeEntregaMarcada: separador de miles solo visual, no altera el valor real de la entrega", () => {
    const entrega = { codigo: "E-1051", cliente_nombre: "Pedro", cantidad: 5000, moneda: "USD" };
    mensajeEntregaMarcada(entrega);
    assert.equal(entrega.cantidad, 5000, "el valor numérico original no debe modificarse");
    assert.equal(typeof entrega.cantidad, "number");
});

// ── manejarEntrega (canal calculadora web): receptor_nombre debe guardarse
// con el nombre de "quien recibe" (el mismo que operations.titular), NO con
// el pushName/nombre de quien paga -- ver public/calculadora.html
// (construirMensajeWhatsApp: la línea 👤 siempre es nombreCompleto, "Nombre
// y apellidos de quien recibe"). ──

function mensajeEntregaWeb({ nombreReceptor, provincia, municipio }) {
    return [
        "🇨🇺 *NUEVO PEDIDO — YORDA ENVÍOS* #ABCD1234",
        "",
        "Tipo: CUP EN EFECTIVO",
        "",
        "Total a pagar: R$ 300",
        `Recibe: 9.500 CUP`,
        "",
        `👤 Beneficiario: ${nombreReceptor}`,
        "📞 Teléfono: 53555512345",
        `📍 Provincia: ${provincia}`,
        `📍 Municipio: ${municipio}`,
        "🏠 Dirección: Calle 23 #456",
        "",
        "🚚 Entrega: Disponible"
    ].join("\n");
}

test("manejarEntrega (calculadora web): guarda receptor_nombre = quien recibe (formulario), no el pushName de quien paga", async (t) => {
    let insertEntregaParams = null;
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^SELECT \* FROM operations WHERE ref_web/.test(sql)) return { rows: [] };
        if (/SELECT nivel_vip FROM customers/.test(sql)) return { rows: [] };
        if (/FROM rates LIMIT 1/.test(sql)) return { rows: [] };
        if (/FROM ofertas LIMIT 1/.test(sql)) return { rows: [] };
        if (/SELECT phone FROM customers/.test(sql)) return { rows: [] };
        if (/INSERT INTO customers/.test(sql) || /UPDATE customers SET/.test(sql)) return { rows: [] };
        if (/INSERT INTO operations/.test(sql)) return { rows: [{ id: 1 }] };
        if (/INSERT INTO entregas_historial/.test(sql)) return { rows: [] };
        return { rows: [] };
    });
    t.mock.method(pool, "connect", async () => ({
        query: async (sql, params = []) => {
            if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return {};
            if (/nextval/.test(sql)) return { rows: [{ n: 2000 }] };
            if (/^\s*INSERT INTO entregas\b/.test(sql)) {
                insertEntregaParams = params;
                return { rows: [{ id: 1, codigo: "E-2000" }] };
            }
            return { rows: [] };
        },
        release() {}
    }));

    const texto = mensajeEntregaWeb({ nombreReceptor: "Ana García (receptora)", provincia: "La Habana", municipio: "Playa" });
    // pushName distinto del receptor -- simula el caso real: quien manda el
    // pedido por WhatsApp (o cuyo perfil se usa) no es necesariamente quien
    // recibe el efectivo en Cuba.
    const ok = await procesarPedidoWeb("5511900070099", texto, "María Paga (perfil WhatsApp)");
    assert.equal(ok, true);

    assert.ok(insertEntregaParams, "debe haber insertado la entrega");
    // Columnas del INSERT INTO entregas: codigo, operation_id, ref_web,
    // phone, cliente_nombre, telefono_entrega, cantidad, moneda, modalidad,
    // provincia, municipio, direccion, referencia, observaciones,
    // receptor_nombre ($15) -- ver src/services/entregas.js:agregarEntrega.
    assert.equal(insertEntregaParams[14], "Ana García (receptora)", "receptor_nombre debe ser quien recibe, no el pushName de quien paga");
    assert.notEqual(insertEntregaParams[14], "María Paga (perfil WhatsApp)");
});
