"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — idempotencia de crearEntregaManual
// (src/flows/pedido-web-flow.js)
//
// Cubre exactamente lo pedido: doble creación con la MISMA idempotencyKey
// crea una sola entrega, y dos intentos legítimos con claves distintas
// siguen creando dos entregas separadas.
//
// crearEntregaManual también dispara notificaciones reales de WhatsApp
// (notificarNuevaEntrega, enviarSeguro al cliente), y src/flows/shared.js
// las destructura de src/services/zapi.js (`const { enviarConDelay } =
// require(...)`) -- una vez destructurada, mockear una propiedad del
// módulo real después no cambia nada de lo que shared.js ya capturó. Por
// eso se reemplaza el módulo completo en require.cache ANTES de que algo
// lo cargue por primera vez: además de evitar llamadas de red reales,
// esto evita los retrasos artificiales de "escribiendo..." (setTimeout
// reales de hasta ~4.5s + jitter) que harían cada test lentísimo sin
// aportar nada a lo que se está probando aquí. Cada archivo de test de
// `node --test` corre en su propio proceso, así que esto no afecta a
// ningún otro archivo.
// ─────────────────────────────────────────────────────────

const zapiPath = require.resolve("../src/services/zapi");
require.cache[zapiPath] = {
    id: zapiPath,
    filename: zapiPath,
    loaded: true,
    exports: {
        enviarMensaje: async () => true,
        enviarImagen: async () => {},
        enviarConDelay: async () => {},
        mostrarEscribiendo: async () => {},
        calcularDelay: () => 0
    }
};

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const { crearEntregaManual } = require("../src/flows/pedido-web-flow");

function mockPoolCompleto(t) {
    const idemTabla = new Map();      // idempotency_keys en memoria
    let siguienteOperationId = 1;
    let siguienteCodigoSeq = 1000;
    let siguienteEntregaId = 1;
    let fallarProximaOperacion = false;

    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^INSERT INTO idempotency_keys/.test(sql)) {
            const [key] = params;
            if (idemTabla.has(key)) return { rows: [] };
            idemTabla.set(key, { resource_id: null });
            return { rows: [{ key }] };
        }
        if (/^SELECT resource_id FROM idempotency_keys/.test(sql)) {
            const [key] = params;
            const fila = idemTabla.get(key);
            return { rows: fila ? [{ resource_id: fila.resource_id }] : [] };
        }
        if (/^UPDATE idempotency_keys/.test(sql)) {
            const [resourceId, key] = params;
            if (idemTabla.has(key)) idemTabla.get(key).resource_id = resourceId;
            return { rows: [] };
        }
        if (/^DELETE FROM idempotency_keys/.test(sql)) {
            const [key] = params;
            const fila = idemTabla.get(key);
            if (fila && fila.resource_id === null) idemTabla.delete(key);
            return { rows: [] };
        }
        if (/SELECT phone FROM customers/.test(sql)) return { rows: [] };
        if (/INSERT INTO customers/.test(sql)) return { rows: [] };
        if (/INSERT INTO operations/.test(sql)) {
            if (fallarProximaOperacion) { fallarProximaOperacion = false; return { rows: [] }; }
            const id = siguienteOperationId++;
            return { rows: [{ id, status: "pendiente" }] };
        }
        if (/INSERT INTO entregas_historial/.test(sql)) return { rows: [] };
        if (/^SELECT \* FROM entregas WHERE id = \$1/.test(sql)) {
            const [id] = params;
            return { rows: [{ id, codigo: `E-${id}` }] };
        }
        return { rows: [] };
    });

    t.mock.method(pool, "connect", async () => {
        let codigoActual = null;
        return {
            query: async (sql) => {
                if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return {};
                if (/nextval/.test(sql)) { codigoActual = siguienteCodigoSeq++; return { rows: [{ n: codigoActual }] }; }
                if (/^\s*INSERT INTO entregas\b/.test(sql)) {
                    const id = siguienteEntregaId++;
                    return { rows: [{ id, codigo: `E-${codigoActual}` }] };
                }
                return { rows: [] };
            },
            release() {}
        };
    });

    return { fallarOperacionSiguiente: () => { fallarProximaOperacion = true; } };
}

const DATOS_BASE = {
    telefonoCliente: "5511900000001",
    clienteNombre: "Cliente Test",
    montoBRL: "100",
    receptorNombre: "Receptor Test",
    cantidad: "9500",
    moneda: "CUP"
};

test("misma idempotencyKey dos veces -> crea UNA sola entrega, la segunda devuelve la misma", async (t) => {
    mockPoolCompleto(t);
    const datos = { ...DATOS_BASE, idempotencyKey: "clave-doble-clic-1" };

    const r1 = await crearEntregaManual(datos);
    const r2 = await crearEntregaManual(datos); // simula el doble clic: misma clave

    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    assert.ok(!r1.duplicado);
    assert.equal(r2.duplicado, true);
    assert.equal(r2.entrega.id, r1.entrega.id, "la segunda llamada debe devolver la MISMA entrega, no crear otra");
});

test("dos intentos legítimos con idempotencyKey distintas -> se crean DOS entregas separadas", async (t) => {
    mockPoolCompleto(t);
    const r1 = await crearEntregaManual({ ...DATOS_BASE, idempotencyKey: "clave-legitima-A" });
    const r2 = await crearEntregaManual({ ...DATOS_BASE, telefonoCliente: "5511900000002", idempotencyKey: "clave-legitima-B" });

    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    assert.notEqual(r1.entrega.id, r2.entrega.id, "dos operaciones legítimas nunca deben coincidir en el mismo recurso");
});

test("sin idempotencyKey (compatibilidad hacia atrás) -> sin dedup, cada llamada crea su propia entrega", async (t) => {
    mockPoolCompleto(t);
    const r1 = await crearEntregaManual({ ...DATOS_BASE });
    const r2 = await crearEntregaManual({ ...DATOS_BASE });
    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    assert.notEqual(r1.entrega.id, r2.entrega.id);
});

test("sin receptorNombre -> error, no crea ni operación ni entrega (cliente y receptor son roles obligatorios distintos)", async (t) => {
    mockPoolCompleto(t);
    const { receptorNombre, ...sinReceptor } = DATOS_BASE;
    const r = await crearEntregaManual(sinReceptor);
    assert.ok(r.error);
    assert.equal(r.success, undefined);
});

test("si agregarOperacion falla, la clave se libera y un reintento con la misma clave sí puede crear la entrega", async (t) => {
    const mock = mockPoolCompleto(t);
    const datos = { ...DATOS_BASE, idempotencyKey: "clave-retry-tras-fallo" };

    mock.fallarOperacionSiguiente();
    const r1 = await crearEntregaManual(datos);
    assert.equal(r1.error, "No se pudo registrar la operación.");

    const r2 = await crearEntregaManual(datos); // reintento real del mismo intento
    assert.equal(r2.success, true, "el reintento tras un fallo real no debe quedar bloqueado como \"ya en curso\"");
});
