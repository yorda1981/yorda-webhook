"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — Operadores de Transferencias
// (src/services/operadores.js)
//
// Cubre: clasificación de tipo real -> modalidad (EXCLUSIVA de
// Transferencias, nunca Recargas/Entregas), CRUD, filtro por modalidad
// activa, construcción del mensaje con datos reales, e idempotencia +
// trazabilidad del aviso (migración 0015).
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
const operadores = require("../src/services/operadores");

test.beforeEach(() => { mensajesEnviados = []; });

// ── Clasificación tipo -> modalidad ──

test("modalidadDeTipo: reconoce los tipos reales de Transferencias de ambos canales (WhatsApp y calculadora web)", () => {
    assert.equal(operadores.modalidadDeTipo("brl_cup"), "cup");
    assert.equal(operadores.modalidadDeTipo("cup_transferencia"), "cup");
    assert.equal(operadores.modalidadDeTipo("usd_clasica"), "usd");
    assert.equal(operadores.modalidadDeTipo("usd_prepago"), "usd");
    assert.equal(operadores.modalidadDeTipo("usd_pendiente_tipo"), "usd");
    assert.equal(operadores.modalidadDeTipo("usd_transferencia"), "usd");
    assert.equal(operadores.modalidadDeTipo("mlc"), "mlc");
    assert.equal(operadores.modalidadDeTipo("mlc_transferencia"), "mlc");
});

test("modalidadDeTipo: Recargas y Entregas de efectivo NUNCA son Transferencias", () => {
    assert.equal(operadores.modalidadDeTipo("recarga_nacional"), null);
    assert.equal(operadores.modalidadDeTipo("recarga_internacional"), null);
    assert.equal(operadores.modalidadDeTipo("cup_efectivo"), null);
    assert.equal(operadores.modalidadDeTipo("usd_efectivo"), null);
});

test("esOperacionDeTransferencia: refleja exactamente modalidadDeTipo", () => {
    assert.equal(operadores.esOperacionDeTransferencia({ tipo: "brl_cup" }), true);
    assert.equal(operadores.esOperacionDeTransferencia({ tipo: "recarga_nacional" }), false);
    assert.equal(operadores.esOperacionDeTransferencia({ tipo: "usd_efectivo" }), false);
});

test("normalizarModalidades: descarta valores fuera del conjunto cerrado, sin duplicados", () => {
    assert.deepEqual(operadores.normalizarModalidades(["cup", "usd", "cup", "inventado"]), ["cup", "usd"]);
    assert.deepEqual(operadores.normalizarModalidades(["TODOS"]), ["todos"]);
    assert.deepEqual(operadores.normalizarModalidades(null), []);
});

// ── CRUD ──

function mockOperadoresDB(t, { filas = [] } = {}) {
    const tabla = new Map(filas.map(f => [f.id, f]));
    const avisos = new Set(); // idempotencia local a esta instancia del mock, nunca compartida entre tests
    let siguienteId = filas.length ? Math.max(...filas.map(f => f.id)) + 1 : 1;

    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^SELECT \* FROM operadores ORDER BY activo/.test(sql)) {
            return { rows: [...tabla.values()] };
        }
        if (/^SELECT \* FROM operadores WHERE id = \$1/.test(sql)) {
            const fila = tabla.get(Number(params[0]));
            return { rows: fila ? [fila] : [] };
        }
        if (/^INSERT INTO operadores/.test(sql)) {
            const fila = {
                id: siguienteId++, nombre: params[0], telefono: params[1],
                activo: params[2], modalidades: JSON.parse(params[3])
            };
            tabla.set(fila.id, fila);
            return { rows: [fila] };
        }
        if (/^UPDATE operadores SET\s+nombre/.test(sql)) {
            const id = Number(params[4]);
            const fila = tabla.get(id);
            if (!fila) return { rows: [] };
            Object.assign(fila, { nombre: params[0], telefono: params[1], activo: params[2], modalidades: JSON.parse(params[3]) });
            return { rows: [fila] };
        }
        if (/^UPDATE operadores SET activo = \$1/.test(sql)) {
            const id = Number(params[1]);
            const fila = tabla.get(id);
            if (!fila) return { rows: [] };
            fila.activo = params[0];
            return { rows: [fila] };
        }
        if (/^SELECT \* FROM operadores\s+WHERE activo = true/.test(sql)) {
            const modalidad = JSON.parse(params[0])[0];
            const rows = [...tabla.values()].filter(f => f.activo && (f.modalidades.includes("todos") || f.modalidades.includes(modalidad)));
            return { rows };
        }
        // operador_avisos: idempotencia real vía UNIQUE(operador_id, operation_id)
        // -- necesaria aquí también porque notificarOperadoresDeOperacion()
        // llama reclamarAviso() antes de enviar cada WhatsApp.
        if (/^INSERT INTO operador_avisos/.test(sql)) {
            const clave = `${params[0]}:${params[1]}`;
            if (avisos.has(clave)) return { rows: [] };
            avisos.add(clave);
            return { rows: [{ id: avisos.size }] };
        }
        return { rows: [] };
    });

    return tabla;
}

test("crearOperador: guarda nombre/teléfono/modalidades/activo correctamente", async (t) => {
    mockOperadoresDB(t);
    const r = await operadores.crearOperador({ nombre: "Juan Pérez", telefono: "5511900011122", modalidades: ["cup"], activo: true });
    assert.equal(r.error, undefined);
    assert.equal(r.operador.nombre, "Juan Pérez");
    assert.deepEqual(r.operador.modalidades, ["cup"]);
    assert.equal(r.operador.activo, true);
});

test("crearOperador: sin modalidad seleccionada -> error, no crea nada", async (t) => {
    mockOperadoresDB(t);
    const r = await operadores.crearOperador({ nombre: "Pedro", telefono: "5511900011123", modalidades: [] });
    assert.ok(r.error);
});

test("editarOperador: puede cambiar nombre/modalidades sin tocar lo no enviado", async (t) => {
    const tabla = mockOperadoresDB(t, { filas: [{ id: 1, nombre: "Juan", telefono: "551190001", activo: true, modalidades: ["cup"] }] });
    const r = await operadores.editarOperador(1, { modalidades: ["cup", "usd"] });
    assert.equal(r.error, undefined);
    assert.deepEqual(r.operador.modalidades, ["cup", "usd"]);
    assert.equal(r.operador.nombre, "Juan", "nombre no enviado -> se conserva");
});

test("cambiarActivo: activa y desactiva sin borrar el registro", async (t) => {
    const tabla = mockOperadoresDB(t, { filas: [{ id: 1, nombre: "Pedro", telefono: "551190002", activo: true, modalidades: ["usd"] }] });
    const desactivado = await operadores.cambiarActivo(1, false);
    assert.equal(desactivado.activo, false);
    assert.equal(tabla.has(1), true, "el operador sigue registrado, solo inactivo");

    const reactivado = await operadores.cambiarActivo(1, true);
    assert.equal(reactivado.activo, true);
});

// ── Filtro por modalidad activa ──

const JUAN_CUP  = { id: 1, nombre: "Juan",  telefono: "5511900001", activo: true,  modalidades: ["cup"] };
const PEDRO_USD = { id: 2, nombre: "Pedro", telefono: "5511900002", activo: false, modalidades: ["usd"] }; // inactivo
const CARLOS_TODOS = { id: 3, nombre: "Carlos", telefono: "5511900003", activo: true, modalidades: ["todos"] };
const MARIA_MLC = { id: 4, nombre: "Maria", telefono: "5511900004", activo: true, modalidades: ["mlc"] };

test("operadoresActivosParaModalidad: filtra por modalidad, ignora inactivos, 'todos' recibe cualquier modalidad", async (t) => {
    mockOperadoresDB(t, { filas: [JUAN_CUP, PEDRO_USD, CARLOS_TODOS, MARIA_MLC] });

    const paraCup = await operadores.operadoresActivosParaModalidad("cup");
    assert.deepEqual(paraCup.map(o => o.nombre).sort(), ["Carlos", "Juan"]);

    const paraUsd = await operadores.operadoresActivosParaModalidad("usd");
    assert.deepEqual(paraUsd.map(o => o.nombre), ["Carlos"], "Pedro está inactivo -- no debe recibir aunque esté habilitado para usd");

    const paraMlc = await operadores.operadoresActivosParaModalidad("mlc");
    assert.deepEqual(paraMlc.map(o => o.nombre).sort(), ["Carlos", "Maria"]);
});

// ── Datos reales del mensaje ──

test("datosMontoOperador: brl_cup -> pagado en R$, destino en CUP", () => {
    const d = operadores.datosMontoOperador({ tipo: "brl_cup", monto: 300, cup: 33000 });
    assert.equal(d.pagado, "R$300");
    assert.equal(d.destino, "33000 CUP");
});

test("datosMontoOperador: usd_clasica -> pagado en R$ (columna cup), destino en USD (columna monto)", () => {
    const d = operadores.datosMontoOperador({ tipo: "usd_clasica", monto: 100, cup: 560 });
    assert.equal(d.pagado, "R$560");
    assert.equal(d.destino, "100 USD");
});

test("datosMontoOperador: mlc -> pagado en R$ (columna cup), destino en MLC (columna monto)", () => {
    const d = operadores.datosMontoOperador({ tipo: "mlc", monto: 50, cup: 13500 });
    assert.equal(d.pagado, "R$13500");
    assert.equal(d.destino, "50 MLC");
});

test("datosMontoOperador: tipo que no es Transferencia -> null, nunca inventa datos", () => {
    assert.equal(operadores.datosMontoOperador({ tipo: "recarga_nacional", monto: 100 }), null);
    assert.equal(operadores.datosMontoOperador({ tipo: "cup_efectivo", monto: 100 }), null);
});

test("construirMensajeOperador: formato mínimo -- solo #operación, cliente, destino real y tarjeta", () => {
    const msg = operadores.construirMensajeOperador({
        id: 434, titular: "LOURDES ABREU ACOSTA", tipo: "brl_cup", monto: 300, cup: 20130,
        tarjeta: "9205069993259455", banco: "BPA"
    });
    assert.equal(
        msg,
        "🔔 *Nueva transferencia #434*\n\nCliente: LOURDES ABREU ACOSTA\nEnviar: 20130 CUP\nTarjeta: 9205069993259455"
    );
});

test("construirMensajeOperador: USD -- mismo formato, moneda y destino real del tipo (usd_clasica)", () => {
    const msg = operadores.construirMensajeOperador({
        id: 435, titular: "Cliente Real", tipo: "usd_clasica", monto: 100, cup: 560,
        tarjeta: "9876543210123456", banco: "BPA"
    });
    assert.equal(
        msg,
        "🔔 *Nueva transferencia #435*\n\nCliente: Cliente Real\nEnviar: 100 USD\nTarjeta: 9876543210123456"
    );
});

test("construirMensajeOperador: MLC -- mismo formato, moneda y destino real del tipo", () => {
    const msg = operadores.construirMensajeOperador({
        id: 436, titular: "Cliente MLC", tipo: "mlc", monto: 50, cup: 13500,
        tarjeta: "1112223334445556", banco: "Metropolitano"
    });
    assert.equal(
        msg,
        "🔔 *Nueva transferencia #436*\n\nCliente: Cliente MLC\nEnviar: 50 MLC\nTarjeta: 1112223334445556"
    );
});

test("construirMensajeOperador: nunca incluye el monto recibido en BRL, línea de Tipo, ni Banco (datos administrativos que el CRM ya conserva)", () => {
    const msg = operadores.construirMensajeOperador({
        id: 437, titular: "Cliente Real", tipo: "usd_clasica", monto: 100, cup: 560,
        tarjeta: "9876543210123456", banco: "BPA"
    });
    assert.doesNotMatch(msg, /R\$/);
    assert.doesNotMatch(msg, /Tipo:/);
    assert.doesNotMatch(msg, /Banco/);
    assert.doesNotMatch(msg, /BPA/);
    assert.doesNotMatch(msg, /Operación:/);
});

// ── Idempotencia + trazabilidad (migración 0015) ──

function mockAvisosDB(t) {
    const avisos = new Set(); // "operadorId:operationId"
    const filas = [];
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^INSERT INTO operador_avisos/.test(sql)) {
            const clave = `${params[0]}:${params[1]}`;
            if (avisos.has(clave)) return { rows: [] }; // ON CONFLICT DO NOTHING
            avisos.add(clave);
            const fila = { id: filas.length + 1, operador_id: params[0], operation_id: params[1], enviado_at: new Date() };
            filas.push(fila);
            return { rows: [{ id: fila.id }] };
        }
        if (/^SELECT oa\.operador_id, o\.nombre/.test(sql)) {
            return { rows: filas.filter(f => f.operation_id === Number(params[0])).map(f => ({ ...f, operador_nombre: "Juan" })) };
        }
        return { rows: [] };
    });
    return { avisos, filas };
}

test("reclamarAviso: primera vez -> true (gana el derecho a avisar); segunda vez -> false (ya se avisó, no reenvía)", async (t) => {
    mockAvisosDB(t);
    const primera = await operadores.reclamarAviso(1, 100);
    const segunda = await operadores.reclamarAviso(1, 100);
    assert.equal(primera, true);
    assert.equal(segunda, false, "un retry sobre el mismo par operador+operación nunca debe volver a ganar");
});

test("notificarOperadoresDeOperacion: retry (misma operación, dos llamadas) NO duplica el WhatsApp al operador", async (t) => {
    mockOperadoresDB(t, { filas: [JUAN_CUP] });

    const operacion = { id: 435, tipo: "brl_cup", titular: "Cliente Real", monto: 300, cup: 33000, tarjeta: "1111222233334444", banco: "BPA" };
    await operadores.notificarOperadoresDeOperacion(operacion);
    await operadores.notificarOperadoresDeOperacion(operacion); // retry

    const alJuan = mensajesEnviados.filter(m => m.phone === "5511900001");
    assert.equal(alJuan.length, 1, "el segundo intento (retry) no debe mandar un segundo WhatsApp");
});

test("notificarOperadoresDeOperacion: Recarga NO notifica a ningún operador", async (t) => {
    mockOperadoresDB(t, { filas: [CARLOS_TODOS] });
    const r = await operadores.notificarOperadoresDeOperacion({ id: 1, tipo: "recarga_nacional", monto: 100 });
    assert.deepEqual(r.notificados, []);
    assert.equal(mensajesEnviados.length, 0);
});

test("notificarOperadoresDeOperacion: Entrega de efectivo NO notifica a ningún operador", async (t) => {
    mockOperadoresDB(t, { filas: [CARLOS_TODOS] });
    const r = await operadores.notificarOperadoresDeOperacion({ id: 1, tipo: "cup_efectivo", monto: 100 });
    assert.deepEqual(r.notificados, []);
    assert.equal(mensajesEnviados.length, 0);
});

test("notificarOperadoresDeOperacion: operador inactivo NO recibe", async (t) => {
    mockOperadoresDB(t, { filas: [PEDRO_USD] }); // inactivo, habilitado para usd
    await operadores.notificarOperadoresDeOperacion({ id: 1, tipo: "usd_clasica", monto: 100, cup: 560 });
    assert.equal(mensajesEnviados.length, 0);
});

test("notificarOperadoresDeOperacion: operador activo pero SIN esa modalidad autorizada NO recibe", async (t) => {
    mockOperadoresDB(t, { filas: [JUAN_CUP] }); // solo cup
    await operadores.notificarOperadoresDeOperacion({ id: 1, tipo: "usd_clasica", monto: 100, cup: 560 });
    assert.equal(mensajesEnviados.length, 0);
});

test("notificarOperadoresDeOperacion: dos operadores válidos para la misma modalidad -> ambos reciben", async (t) => {
    const OTRO_CUP = { id: 5, nombre: "Otro", telefono: "5511900005", activo: true, modalidades: ["cup"] };
    mockOperadoresDB(t, { filas: [JUAN_CUP, OTRO_CUP] });
    await operadores.notificarOperadoresDeOperacion({ id: 1, tipo: "brl_cup", monto: 300, cup: 33000, titular: "Cliente" });
    const telefonos = mensajesEnviados.map(m => m.phone).sort();
    assert.deepEqual(telefonos, ["5511900001", "5511900005"]);
});

test("obtenerTrazabilidad: devuelve quién fue avisado y cuándo para una operación", async (t) => {
    const { filas } = mockAvisosDB(t);
    await operadores.reclamarAviso(1, 100);
    const trazas = await operadores.obtenerTrazabilidad(100);
    assert.equal(trazas.length, 1);
    assert.equal(trazas[0].operador_nombre, "Juan");
    assert.ok(trazas[0].enviado_at);
});
