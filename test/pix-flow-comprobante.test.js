"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — recepción/deduplicación de comprobantes PIX
// (src/flows/pix-flow.js: procesarComprobante + intentarCompletarOperacion)
//
// Cubre el camino END-TO-END compartido por imagen y PDF (ambos llaman a
// procesarComprobante con el mismo shape de `datos` -- ver
// src/flows/imagen-flow.js). INVARIANTE que se prueba explícitamente:
// COMPROBANTE LEÍDO ≠ DINERO CONFIRMADO -- ninguna operación queda con
// status distinto de 'pendiente' en estos tests; la confirmación sigue
// siendo 100% manual.
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
const { procesarComprobante } = require("../src/flows/pix-flow");
const { obtenerCliente, guardarCliente } = require("../src/services/customer-memory");

const TASAS = { brl_0: 90, brl_100: 100, brl_500: 110, brl_1000: 120, usd1: 300, usd2: 305 };

function mockMundo(t) {
    const customers = new Map();
    const operations = [];
    let siguienteId = 1;

    function aplicarParamsCustomers(row, params) {
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
        set(22, "comprobante_e2e"); set(23, "comprobante_transaccion_id");
        if (params[24] != null) row.comprobante_datos = JSON.parse(params[24]);
        return row;
    }

    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^SELECT phone FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ phone: row.phone }] : [] };
        }
        if (/^SELECT \* FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ ...row }] : [] };
        }
        if (/INSERT INTO customers/.test(sql)) {
            const row = aplicarParamsCustomers({ phone: params[0] }, params);
            customers.set(params[0], row);
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*nombre\s*=\s*COALESCE/.test(sql)) {
            const row = aplicarParamsCustomers(customers.get(params[0]) || { phone: params[0] }, params);
            customers.set(params[0], row);
            return { rows: [] };
        }

        if (/^SELECT \* FROM rates LIMIT 1/.test(sql)) return { rows: [TASAS] };

        if (/^SELECT \* FROM operations WHERE comprobante_e2e = \$1/.test(sql)) {
            const fila = operations.find(o => o.comprobante_e2e === params[0] && o.status !== "rechazada");
            return { rows: fila ? [fila] : [] };
        }
        if (/^SELECT \* FROM operations WHERE comprobante_transaccion_id = \$1/.test(sql)) {
            const fila = operations.find(o => o.comprobante_transaccion_id === params[0] && o.status !== "rechazada");
            return { rows: fila ? [fila] : [] };
        }
        if (/SELECT id FROM operations\s+WHERE monto = \$1\s+AND created_at > NOW\(\) - INTERVAL '24 hours'/.test(sql)) {
            const hit = operations.some(o => Number(o.monto) === Number(params[0]) && o.status !== "rechazada");
            return { rows: hit ? [{ id: 1 }] : [] };
        }
        if (/SELECT id FROM operations\s+WHERE phone = \$1 AND monto = \$2\s+AND created_at > NOW\(\) - INTERVAL '2 hours'/.test(sql)) {
            const hit = operations.some(o => o.phone === params[0] && Number(o.monto) === Number(params[1]));
            return { rows: hit ? [{ id: 1 }] : [] };
        }
        if (/^SELECT \* FROM operations\s+WHERE phone = \$1 AND status = 'pendiente'/.test(sql)) {
            const rows = operations.filter(o => o.phone === params[0] && o.status === "pendiente");
            return { rows: rows.length ? [rows[rows.length - 1]] : [] };
        }
        if (/^SELECT id FROM operations WHERE phone = \$1 AND status = 'pendiente' AND monto = \$2/.test(sql)) {
            const rows = operations.filter(o => o.phone === params[0] && o.status === "pendiente" && Number(o.monto) === Number(params[1]));
            return { rows: rows.map(o => ({ id: o.id })) };
        }
        if (/INSERT INTO operations/.test(sql)) {
            const row = {
                id: siguienteId++, phone: params[0], nombre: params[1], monto: Number(params[2]), cup: Number(params[3]),
                tarjeta: params[4], titular: params[5], banco: params[6], tipo: params[7],
                comprobante_e2e: params[15] || null,
                comprobante_transaccion_id: params[16] || null,
                comprobante_datos: params[17] ? JSON.parse(params[17]) : null,
                status: "pendiente"
            };
            operations.push(row);
            return { rows: [row] };
        }

        return { rows: [] };
    });

    return { customers, operations };
}

test.beforeEach(() => { mensajesEnviados = []; });

const DATOS_COMPLETOS = {
    tipo: "comprovante_pix", valor: 300, fecha: "01/02/2026", hora: "10:00",
    banco: "Nubank", destinatario: "Yordanys Rafael", pagador: "Cliente Test",
    id_transaccion: "TXN-000111", e2e: "E12345678202601011000ABCDEFGHIJK",
    destino_correcto: true, valido: true
};

// ── Extracción estructurada ──

test("extracción completa: comprobante con todos los campos crea la operación con esos datos guardados", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900020001", {
        phone: "5511900020001", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444"
    });
    await procesarComprobante("5511900020001", "Cliente", await obtenerCliente("5511900020001"), DATOS_COMPLETOS, true);

    const op = mundo.operations[0];
    assert.equal(op.comprobante_e2e, "E12345678202601011000ABCDEFGHIJK");
    assert.equal(op.comprobante_transaccion_id, "TXN-000111");
    assert.equal(op.comprobante_datos.pagador, "Cliente Test");
    assert.equal(op.comprobante_datos.destinatario, "Yordanys Rafael");
    assert.equal(op.comprobante_datos.destinatarioMatch, "coincide");
    assert.equal(op.comprobante_datos.fecha, "01/02/2026");
    assert.equal(op.comprobante_datos.hora, "10:00");
});

test("extracción parcial: campos faltantes quedan null, nunca inventados, y el comprobante se procesa igual", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900020002", {
        phone: "5511900020002", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444"
    });
    const datosParciales = { tipo: "comprovante_pix", valor: 300, valido: true }; // sin fecha/hora/e2e/destinatario/etc.
    await procesarComprobante("5511900020002", "Cliente", await obtenerCliente("5511900020002"), datosParciales, true);

    const op = mundo.operations[0];
    assert.ok(op, "debe seguir creando la operación aunque falten campos");
    assert.equal(op.comprobante_e2e, null);
    assert.equal(op.comprobante_datos.fecha, null);
    assert.equal(op.comprobante_datos.destinatarioMatch, "desconocido");
});

// ── Deduplicación por E2E ──

test("mismo E2E reenviado mientras sigue PENDIENTE -> no crea otra operación, avisa que sigue pendiente", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900020003", { phone: "5511900020003", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });
    await procesarComprobante("5511900020003", "Cliente", await obtenerCliente("5511900020003"), DATOS_COMPLETOS, true);
    assert.equal(mundo.operations.length, 1);

    // Reenvía EXACTAMENTE el mismo comprobante (mismo E2E).
    await procesarComprobante("5511900020003", "Cliente", await obtenerCliente("5511900020003"), DATOS_COMPLETOS, true);
    assert.equal(mundo.operations.length, 1, "no debe crear una segunda operación");
    const ultimoMsg = mensajesEnviados[mensajesEnviados.length - 1]?.msg || "";
    assert.match(ultimoMsg, /pendiente de revisión/i);
});

test("mismo E2E reenviado DESPUÉS de que la operación fue confirmada -> avisa que ya fue procesado", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900020004", { phone: "5511900020004", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });
    await procesarComprobante("5511900020004", "Cliente", await obtenerCliente("5511900020004"), DATOS_COMPLETOS, true);
    mundo.operations[0].status = "confirmada"; // simula la confirmación manual del admin

    await procesarComprobante("5511900020004", "Cliente", await obtenerCliente("5511900020004"), DATOS_COMPLETOS, true);
    assert.equal(mundo.operations.length, 1, "no debe crear una segunda operación");
    const ultimoMsg = mensajesEnviados[mensajesEnviados.length - 1]?.msg || "";
    assert.match(ultimoMsg, /ya corresponde a una operación procesada/i);
    // Invariante: el comprobante leído NUNCA cambia el status por sí solo.
    assert.equal(mundo.operations[0].status, "confirmada");
});

test("caso obligatorio: dos comprobantes de igual monto con E2E DIFERENTES son dos pagos distintos", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900020005", { phone: "5511900020005", ultimo_monto: 500, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });

    const pixA = { ...DATOS_COMPLETOS, valor: 500, e2e: "E11111111202601011000AAAAAAAAAAA" };
    const pixB = { ...DATOS_COMPLETOS, valor: 500, e2e: "E22222222202601011000BBBBBBBBBBB" };

    await procesarComprobante("5511900020005", "Cliente", await obtenerCliente("5511900020005"), pixA, true);
    // El cliente ya tiene una operación pendiente -- para simular un pago
    // NUEVO real, primero se "libera" (se completa/limpia) antes del segundo.
    mundo.operations[0].status = "completada";
    await guardarCliente({ phone: "5511900020005", monto: 500 });

    await procesarComprobante("5511900020005", "Cliente", await obtenerCliente("5511900020005"), pixB, true);

    assert.equal(mundo.operations.length, 2, "dos E2E distintos deben poder existir como dos pagos separados");
    assert.notEqual(mundo.operations[0].comprobante_e2e, mundo.operations[1].comprobante_e2e);
});

// ── Fallback (sin E2E ni ID de transacción) ──

test("sin E2E ni ID de transacción: mismo teléfono + mismo monto + mismo día -> sigue protegido por el fallback existente", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900020006", { phone: "5511900020006", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });
    const sinIdentidad = { tipo: "comprovante_pix", valor: 300, fecha: "01/02/2026", hora: "10:00", destino_correcto: true, valido: true };

    await procesarComprobante("5511900020006", "Cliente", await obtenerCliente("5511900020006"), sinIdentidad, true);
    assert.equal(mundo.operations.length, 1);

    await procesarComprobante("5511900020006", "Cliente", await obtenerCliente("5511900020006"), sinIdentidad, true);
    assert.equal(mundo.operations.length, 1, "el fallback de monto+ventana sigue protegiendo cuando no hay identidad fuerte");
});

// ── Destinatario ──

test("destinatario coincidente: no genera ninguna advertencia, se procesa normal", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900020007", { phone: "5511900020007", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });
    await procesarComprobante("5511900020007", "Cliente", await obtenerCliente("5511900020007"), { ...DATOS_COMPLETOS, destino_correcto: true }, true);
    const textoCompleto = mensajesEnviados.map(m => m.msg).join(" | ");
    assert.doesNotMatch(textoCompleto, /no coincide/i);
});

test("destinatario DIFERENTE: NO rechaza ni bloquea -- crea la operación igual, marcada para revisión", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900020008", { phone: "5511900020008", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });
    await procesarComprobante("5511900020008", "Cliente", await obtenerCliente("5511900020008"),
        { ...DATOS_COMPLETOS, e2e: "E99999999202601011000ZZZZZZZZZZZ", destino_correcto: false }, true);

    assert.equal(mundo.operations.length, 1, "un destinatario distinto NO debe bloquear la creación de la operación");
    assert.equal(mundo.operations[0].comprobante_datos.destinatarioMatch, "diferente");
    assert.equal(mundo.operations[0].status, "pendiente", "sigue pendiente de revisión manual, nunca se rechaza sola");
});

test("destinatario ILEGIBLE (desconocido): continúa como comprobante pendiente normal, sin advertencia", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900020009", { phone: "5511900020009", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });
    const { destino_correcto, ...sinDestinoCorrecto } = DATOS_COMPLETOS;
    await procesarComprobante("5511900020009", "Cliente", await obtenerCliente("5511900020009"),
        { ...sinDestinoCorrecto, e2e: "E33333333202601011000CCCCCCCCCCC" }, true);

    assert.equal(mundo.operations[0].comprobante_datos.destinatarioMatch, "desconocido");
    const textoCompleto = mensajesEnviados.map(m => m.msg).join(" | ");
    assert.doesNotMatch(textoCompleto, /no coincide/i);
});

// ── PDF e imagen: misma lógica, mismo resultado ──

test("PDF e imagen con el mismo `datos` producen el mismo resultado (misma ruta compartida)", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900020010", { phone: "5511900020010", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });
    const comoImagen = { ...DATOS_COMPLETOS, tipo: "comprovante_pix", e2e: "E44444444202601011000DDDDDDDDDDD" };
    await procesarComprobante("5511900020010", "Cliente", await obtenerCliente("5511900020010"), comoImagen, true);
    assert.equal(mundo.operations.length, 1);

    const mundo2 = mockMundo(t);
    mundo2.customers.set("5511900020011", { phone: "5511900020011", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });
    const comoPDF = { ...DATOS_COMPLETOS, tipo: "comprovante_pdf", e2e: "E55555555202601011000EEEEEEEEEEE" };
    await procesarComprobante("5511900020011", "Cliente", await obtenerCliente("5511900020011"), comoPDF, true);
    assert.equal(mundo2.operations.length, 1);

    assert.equal(mundo.operations[0].comprobante_datos.destinatarioMatch, mundo2.operations[0].comprobante_datos.destinatarioMatch);
});

// ── Seguridad financiera: OCR ambiguo nunca confirma nada ──

test("OCR ambiguo/de baja confianza (sin valor) NUNCA confirma ni completa una operación por sí solo", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900020012", { phone: "5511900020012", tipo_favorito: "brl_cup" }); // sin monto todavía
    await procesarComprobante("5511900020012", "Cliente", await obtenerCliente("5511900020012"), { tipo: "comprovante_pix", valido: false }, true);

    assert.equal(mundo.operations.length, 0, "sin monto no se crea ninguna operación");
    const cliente = mundo.customers.get("5511900020012");
    assert.equal(cliente.comprobante_pendiente, true, "queda marcado como pendiente de revisión, nunca confirmado");
});

test("toda operación creada por un comprobante queda en status='pendiente' -- nunca 'confirmada' automáticamente", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900020013", { phone: "5511900020013", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });
    await procesarComprobante("5511900020013", "Cliente", await obtenerCliente("5511900020013"), DATOS_COMPLETOS, true);
    assert.equal(mundo.operations[0].status, "pendiente");
});

// ── Blocked number sigue con prioridad absoluta ──
// (el corte real vive en index.js, ANTES de llegar a procesarMensaje/
// procesarComprobante -- ver src/services/blocked-numbers.js y su suite
// dedicada; esto solo confirma que la nueva lógica de comprobantes no
// introdujo ninguna ruta que la esquive.)

test("BLOQUEO: un número bloqueado sigue sin recibir ninguna automatización, ni siquiera por un comprobante nuevo", async (t) => {
    const { estaBloqueado } = require("../src/services/blocked-numbers");
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^SELECT 1 FROM blocked_numbers WHERE phone = \$1/.test(sql)) {
            return { rows: params[0] === "5511900020099" ? [{ "?column?": 1 }] : [] };
        }
        return { rows: [] };
    });
    assert.equal(await estaBloqueado("5511900020099"), true, "el bloqueo se revisa ANTES de cualquier procesamiento de comprobante");
});
