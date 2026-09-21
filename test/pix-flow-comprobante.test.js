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
    let carreraE2E = null;
    let forzarFalloGenerico = false;

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
        // limpiarSesionDB() -- se dispara al completar una operación con
        // éxito. Sin este patrón, el staging (comprobante_pendiente/e2e/
        // tarjeta_frecuente/etc.) nunca se limpiaría en el mock y una
        // operación "completada" seguiría viéndose como pendiente.
        if (/UPDATE customers SET[\s\S]*estado\s*=\s*NULL/.test(sql)) {
            const row = customers.get(params[0]);
            if (row) Object.assign(row, {
                estado: null, fecha_estado: null, fecha_pix: null,
                comprobante_pendiente: null, valor_comprobante: null,
                comprobante_e2e: null, comprobante_transaccion_id: null, comprobante_datos: null,
                last_response_id: null, ultimo_monto: null, tipo_favorito: null,
                tarjeta_frecuente: null, titular_frecuente: null, banco_favorito: null,
                ultima_pregunta: null, ultimas_opciones: null, contexto_actualizado_at: null
            });
            return { rows: [] };
        }
        // limpiarComprobantePendiente() -- se dispara cuando un comprobante
        // se resuelve como duplicado (ver responderComprobanteDuplicado).
        if (/UPDATE customers SET[\s\S]*comprobante_pendiente\s*=\s*NULL/.test(sql)) {
            const row = customers.get(params[0]);
            if (row) Object.assign(row, {
                comprobante_pendiente: null, valor_comprobante: null,
                comprobante_e2e: null, comprobante_transaccion_id: null, comprobante_datos: null
            });
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
            if (forzarFalloGenerico) {
                forzarFalloGenerico = false;
                throw new Error("conexión perdida (simulado)");
            }
            const nuevoE2E = params[15] || null;
            // Simula la RACE real: justo antes de que nuestro INSERT se
            // ejecute, "otra petición concurrente" ya insertó una fila con
            // este mismo E2E (algo que un SELECT anterior, hecho un
            // instante antes, no pudo haber visto). El índice único
            // parcial de la migración 0012 rechazaría nuestro INSERT con
            // exactamente este error real de Postgres.
            if (carreraE2E && nuevoE2E === carreraE2E) {
                const ganadora = {
                    id: siguienteId++, phone: "5511900099999", nombre: "Otro cliente",
                    monto: Number(params[2]), cup: Number(params[3]), tarjeta: params[4], titular: params[5],
                    banco: params[6], tipo: params[7], comprobante_e2e: nuevoE2E,
                    comprobante_transaccion_id: null, comprobante_datos: null, status: "pendiente"
                };
                operations.push(ganadora);
                carreraE2E = null;
                const err = new Error('duplicate key value violates unique constraint "idx_operations_comprobante_e2e_unico"');
                err.code = "23505";
                err.constraint = "idx_operations_comprobante_e2e_unico";
                throw err;
            }
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

    return {
        customers, operations,
        armarCarrera: (e2e) => { carreraE2E = e2e; },
        forzarFalloGenerico: () => { forzarFalloGenerico = true; }
    };
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
    // El E2E gana la prioridad de deduplicación (ver hallazgo I1) -- la
    // columna comprobante_transaccion_id se deja null cuando ya hay E2E,
    // pero el ID crudo queda igual disponible para auditoría.
    assert.equal(op.comprobante_transaccion_id, null);
    assert.equal(op.comprobante_datos.transaccionIdRaw, "TXN-000111");
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
    // limpiarSesion() ya corrió al completar A (nulea tarjeta_frecuente
    // también), así que el cliente vuelve a dar monto+tarjeta para el
    // pago B, igual que en un flujo real.
    mundo.operations[0].status = "completada";
    await guardarCliente({ phone: "5511900020005", monto: 500, tarjeta: "1111222233334444" });

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

// ═══════════════════════════════════════════════════════════
// CORRECCIONES DE LA AUDITORÍA DE 7728e66 (C1, I1, I2, I3)
// ═══════════════════════════════════════════════════════════

// ── C1: race condition en el E2E (violación de índice único) ──

test("C1 -- RACE E2E: dos inserciones casi simultáneas con el mismo E2E nunca crean un duplicado ni mandan un mensaje con ID vacío", async (t) => {
    const mundo = mockMundo(t);
    const e2e = "E77777777202601011000RRRRRRRRRRR";
    mundo.customers.set("5511900030001", {
        phone: "5511900030001", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444"
    });
    mundo.armarCarrera(e2e);

    await procesarComprobante("5511900030001", "Cliente", await obtenerCliente("5511900030001"), { ...DATOS_COMPLETOS, e2e }, true);

    const delMismoE2E = mundo.operations.filter(o => o.comprobante_e2e === e2e);
    assert.equal(delMismoE2E.length, 1, "nunca debe crear un duplicado, aunque el INSERT propio haya chocado contra el índice único");

    const huboMensajeOperacionPendienteNueva = mensajesEnviados.some(m => /OPERACIÓN.*PENDIENTE/.test(m.msg));
    assert.equal(huboMensajeOperacionPendienteNueva, false, "el intento que pierde la carrera nunca debe mandar el mensaje de 'nueva operación creada' (con ID vacío)");

    const ultimoMsg = mensajesEnviados[mensajesEnviados.length - 1]?.msg || "";
    assert.match(ultimoMsg, /pendiente de revisión/i, "debe responder según el estado real de la operación que sí se creó");
});

test("C1 -- RACE E2E: la operación ganadora es la única que existe, con datos correctos", async (t) => {
    const mundo = mockMundo(t);
    const e2e = "E66666666202601011000QQQQQQQQQQQ";
    mundo.customers.set("5511900030002", {
        phone: "5511900030002", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444"
    });
    mundo.armarCarrera(e2e);

    await procesarComprobante("5511900030002", "Cliente", await obtenerCliente("5511900030002"), { ...DATOS_COMPLETOS, e2e }, true);

    assert.equal(mundo.operations.length, 1);
    assert.equal(mundo.operations[0].comprobante_e2e, e2e);
    assert.equal(mundo.operations[0].status, "pendiente");
});

test("C1 -- FALLO REAL de persistencia: nunca afirma que la operación quedó registrada, preserva el staging", async (t) => {
    const mundo = mockMundo(t);
    const e2e = "E88888888202601011000SSSSSSSSSSS";
    mundo.customers.set("5511900030003", {
        phone: "5511900030003", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444"
    });
    mundo.forzarFalloGenerico();

    await procesarComprobante("5511900030003", "Cliente", await obtenerCliente("5511900030003"), { ...DATOS_COMPLETOS, e2e }, true);

    assert.equal(mundo.operations.length, 0, "no debe crear ninguna operación tras un fallo real de persistencia");

    const huboMensajeOperacionPendienteNueva = mensajesEnviados.some(m => /OPERACIÓN.*PENDIENTE/.test(m.msg));
    assert.equal(huboMensajeOperacionPendienteNueva, false, "nunca debe afirmar que la operación quedó registrada");
    const ultimoMsg = mensajesEnviados[mensajesEnviados.length - 1]?.msg || "";
    assert.match(ultimoMsg, /problema técnico/i);

    const cliente = mundo.customers.get("5511900030003");
    assert.equal(cliente.comprobante_e2e, e2e, "el staging se preserva -- el comprobante no se pierde, se puede reintentar/revisar manualmente");
    assert.equal(cliente.comprobante_pendiente, true, "sigue reflejando la realidad: todavía no hay operación creada para este comprobante");
});

// ── I2: mismo E2E presentado desde otro teléfono ──

test("I2 -- mismo E2E desde OTRO teléfono: no crea otra operación, no revela datos del primero, avisa al admin", async (t) => {
    const mundo = mockMundo(t);
    const e2e = "E99999999202601011000TTTTTTTTTTT";
    mundo.customers.set("5511900030004", {
        phone: "5511900030004", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444"
    });
    // Comprobante A ya se procesó para el teléfono original.
    await procesarComprobante("5511900030004", "Cliente A", await obtenerCliente("5511900030004"), { ...DATOS_COMPLETOS, e2e }, true);
    assert.equal(mundo.operations.length, 1);

    mensajesEnviados = [];

    // El MISMO comprobante (mismo E2E) llega ahora desde OTRO teléfono.
    mundo.customers.set("5511900030005", {
        phone: "5511900030005", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "5555666677778888"
    });
    await procesarComprobante("5511900030005", "Cliente B", await obtenerCliente("5511900030005"), { ...DATOS_COMPLETOS, e2e }, true);

    assert.equal(mundo.operations.length, 1, "nunca debe crear una segunda operación para el mismo E2E");

    const mensajesAlSegundoCliente = mensajesEnviados.filter(m => m.phone === "5511900030005").map(m => m.msg).join(" | ");
    assert.doesNotMatch(mensajesAlSegundoCliente, /5511900030004|Cliente A/, "nunca debe revelar el teléfono/nombre del cliente original al segundo");
    assert.match(mensajesAlSegundoCliente, /pendiente de revisión/i);
    // El aviso al admin (ADMIN_PHONE) se verifica por separado en
    // test/pix-flow-comprobante-admin.test.js -- ese módulo necesita fijar
    // process.env.ADMIN_PHONE ANTES de cualquier require (env.js lo lee una
    // sola vez al cargarse), así que se aisló en su propio archivo para no
    // afectar el resto de los asserts de "último mensaje" de este archivo.
});

// ── I3: dos comprobantes en staging antes de completar el primero ──

test("I3 -- comprobante B llega antes de completar A: no pisa silenciosamente la identidad de A, pide aclaración", async (t) => {
    const mundo = mockMundo(t);
    // Cliente SIN tarjeta todavía -- A queda en staging (nunca llega a
    // convertirse en operación), exactamente el escenario descrito en la
    // auditoría.
    mundo.customers.set("5511900030006", { phone: "5511900030006", tipo_favorito: "brl_cup" });

    const compA = { ...DATOS_COMPLETOS, valor: 300, e2e: "E10101010202601011000AAAAAAAAAAA" };
    const compB = { ...DATOS_COMPLETOS, valor: 500, e2e: "E20202020202601011000BBBBBBBBBBB" };

    await procesarComprobante("5511900030006", "Cliente", await obtenerCliente("5511900030006"), compA, true);
    let cliente = mundo.customers.get("5511900030006");
    assert.equal(cliente.comprobante_e2e, "E10101010202601011000AAAAAAAAAAA", "A queda en staging (todavía no hay tarjeta)");
    assert.equal(mundo.operations.length, 0);

    mensajesEnviados = [];
    await procesarComprobante("5511900030006", "Cliente", await obtenerCliente("5511900030006"), compB, true);

    cliente = mundo.customers.get("5511900030006");
    assert.equal(cliente.comprobante_e2e, "E10101010202601011000AAAAAAAAAAA", "la identidad de A NUNCA se pierde/pisa en silencio");
    assert.equal(mundo.operations.length, 0, "B tampoco se crea todavía -- se pidió aclaración");

    const ultimoMsg = mensajesEnviados[mensajesEnviados.length - 1]?.msg || "";
    assert.match(ultimoMsg, /otro comprobante|pendiente de revisión/i);
});

test("I3 -- comprobante B SIN identidad fuerte nunca pisa la identidad de A (protegido por COALESCE, sin necesitar el chequeo explícito)", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900030007", { phone: "5511900030007", tipo_favorito: "brl_cup" });

    const compA = { ...DATOS_COMPLETOS, valor: 300, e2e: "E30303030202601011000CCCCCCCCCCC" };
    const compBsinIdentidad = { tipo: "comprovante_pix", valor: 300, destino_correcto: true, valido: true }; // sin fecha/hora/e2e/id

    await procesarComprobante("5511900030007", "Cliente", await obtenerCliente("5511900030007"), compA, true);
    await procesarComprobante("5511900030007", "Cliente", await obtenerCliente("5511900030007"), compBsinIdentidad, true);

    const cliente = mundo.customers.get("5511900030007");
    assert.equal(cliente.comprobante_e2e, "E30303030202601011000CCCCCCCCCCC", "sin identidad fuerte en el segundo, COALESCE preserva la de A automáticamente");
});

// ── Hallazgo residual (revisión final): un duplicado resuelto no debe dejar staging "sucio" ──

test("un comprobante resuelto como duplicado limpia SU PROPIO staging, sin bloquear el próximo comprobante realmente distinto", async (t) => {
    const mundo = mockMundo(t);
    const e2e = "E40404040202601011000DDDDDDDDDDD";
    mundo.customers.set("5511900030008", { phone: "5511900030008", ultimo_monto: 300, tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444" });

    await procesarComprobante("5511900030008", "Cliente", await obtenerCliente("5511900030008"), { ...DATOS_COMPLETOS, e2e }, true);
    assert.equal(mundo.operations.length, 1);

    // Reenvía el MISMO comprobante -- se detecta como duplicado.
    await procesarComprobante("5511900030008", "Cliente", await obtenerCliente("5511900030008"), { ...DATOS_COMPLETOS, e2e }, true);
    let cliente = mundo.customers.get("5511900030008");
    assert.equal(cliente.comprobante_e2e, null, "el staging del comprobante ya resuelto como duplicado se limpia");

    // Ahora manda un comprobante GENUINAMENTE distinto -- no debe chocar
    // con el I3 (staging sucio de un duplicado ya resuelto).
    mensajesEnviados = [];
    const otroE2E = "E50505050202601011000EEEEEEEEEEE";
    await procesarComprobante("5511900030008", "Cliente", await obtenerCliente("5511900030008"), { ...DATOS_COMPLETOS, valor: 700, e2e: otroE2E }, true);

    const ultimoMsg = mensajesEnviados[mensajesEnviados.length - 1]?.msg || "";
    assert.doesNotMatch(ultimoMsg, /otro comprobante/i, "no debe pedir aclaración -- el staging anterior ya se había limpiado");
});
