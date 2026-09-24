"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const DB_PATH = require.resolve("../db");
const SERVICE_PATH = require.resolve("../src/services/operator-balances");

function cargarServicio(t, { saldo = 150, status = "confirmada", movimientos = [], activo = true, modalidades = ["usd"] } = {}) {
    const estado = {
        saldo, status, operadorId: null, movimientos: [...movimientos], commits: 0, rollbacks: 0,
        operacion: { id: 10, tipo: "usd_transferencia", monto: 560, cup: 100, status, operador_id: null }
    };
    const client = {
        async query(sql, params = []) {
            const q = sql.replace(/\s+/g, " ").trim();
            if (q === "BEGIN") return { rows: [] };
            if (q === "COMMIT") { estado.commits++; return { rows: [] }; }
            if (q === "ROLLBACK") { estado.rollbacks++; return { rows: [] }; }
            if (/SELECT \* FROM operations WHERE id = \$1 FOR UPDATE/.test(q)) return { rows: [{ ...estado.operacion, status: estado.status, operador_id: estado.operadorId }] };
            if (/SELECT id, activo, modalidades, saldo_usd AS saldo/.test(q)) return { rows: [{ id: 3, activo, modalidades, saldo: estado.saldo }] };
            if (/SELECT saldo_usd AS saldo FROM operadores/.test(q)) return { rows: [{ saldo: estado.saldo }] };
            if (/UPDATE operadores SET saldo_usd/.test(q)) { estado.saldo = Number(params[0]); return { rows: [] }; }
            if (/INSERT INTO operador_movimientos/.test(q)) {
                const tipo = q.includes("'descuento'") ? "descuento" : q.includes("'reintegro'") ? "reintegro" : params[3];
                if (estado.movimientos.some(m => m.tipo === tipo && m.operation_id === Number(params[3] || 10))) {
                    const e = new Error("duplicate"); e.code = "23505"; throw e;
                }
                const movimiento = tipo === "ajuste"
                    ? { tipo, operation_id: null, moneda: params[1], monto: Number(params[2]), saldo_anterior: Number(params[4]), saldo_posterior: Number(params[5]), motivo: params[6] }
                    : { tipo, operation_id: 10, moneda: params[1], monto: Number(params[2]) };
                estado.movimientos.push(movimiento);
                return { rows: [{ id: estado.movimientos.length, ...movimiento }] };
            }
            if (/UPDATE operations SET status = 'completada'/.test(q)) {
                if (estado.status !== "confirmada") return { rows: [] };
                estado.status = "completada"; estado.operadorId = Number(params[1]);
                return { rows: [{ ...estado.operacion, status: estado.status, operador_id: estado.operadorId }] };
            }
            if (/tipo = 'descuento' FOR UPDATE/.test(q)) return { rows: estado.movimientos.filter(m => m.tipo === "descuento") };
            if (/tipo = 'reintegro'/.test(q)) return { rows: estado.movimientos.filter(m => m.tipo === "reintegro").map((m, i) => ({ id: i + 1, ...m })) };
            if (/UPDATE operations SET status = \$2/.test(q)) { estado.status = params[1]; return { rows: [] }; }
            throw new Error(`SQL no simulado: ${q}`);
        },
        release() {}
    };
    const pool = { connect: async () => client, query: (...args) => client.query(...args) };
    const anteriorDb = require.cache[DB_PATH];
    const anteriorServicio = require.cache[SERVICE_PATH];
    require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: pool };
    delete require.cache[SERVICE_PATH];
    const servicio = require(SERVICE_PATH);
    t.after(() => {
        delete require.cache[SERVICE_PATH];
        if (anteriorServicio) require.cache[SERVICE_PATH] = anteriorServicio;
        if (anteriorDb) require.cache[DB_PATH] = anteriorDb; else delete require.cache[DB_PATH];
    });
    return { servicio, estado };
}

test("descuenta la cantidad destino en la moneda correcta solo al completar", async t => {
    const { servicio, estado } = cargarServicio(t, { saldo: 150 });
    const r = await servicio.completarConDescuento(10, 3);
    assert.equal(r.operacion.status, "completada");
    assert.equal(estado.saldo, 50);
    assert.deepEqual(estado.movimientos, [{ tipo: "descuento", operation_id: 10, moneda: "USD", monto: -100 }]);
    assert.equal(estado.commits, 1);
});

test("saldo insuficiente impide completar e informa disponible y faltante", async t => {
    const { servicio, estado } = cargarServicio(t, { saldo: 60 });
    await assert.rejects(() => servicio.completarConDescuento(10, 3), e => {
        assert.equal(e.disponible, 60); assert.equal(e.faltante, 40); return /Disponible: 60.00 USD/.test(e.message);
    });
    assert.equal(estado.status, "confirmada");
    assert.equal(estado.saldo, 60);
    assert.equal(estado.rollbacks, 1);
});

test("operador inactivo o sin la modalidad no puede completar", async t => {
    const inactivo = cargarServicio(t, { activo: false });
    assert.deepEqual(await inactivo.servicio.completarConDescuento(10, 3), { error: "El operador seleccionado está inactivo" });
    assert.equal(inactivo.estado.saldo, 150);

    const otraModalidad = cargarServicio(t, { modalidades: ["cup"] });
    assert.deepEqual(await otraModalidad.servicio.completarConDescuento(10, 3), { error: "El operador seleccionado no gestiona transferencias en USD" });
    assert.equal(otraModalidad.estado.saldo, 150);
});

test("ajuste fija el saldo final, permite disminuir hasta cero y audita diferencia y motivo", async t => {
    const { servicio, estado } = cargarServicio(t, { saldo: 100000 });
    const r = await servicio.ajustarSaldo(3, { moneda: "USD", tipo: "ajuste", saldoFinal: 80000, motivo: "Carga registrada por error" });
    assert.equal(estado.saldo, 80000);
    assert.deepEqual(r.movimiento, {
        id: 1, tipo: "ajuste", operation_id: null, moneda: "USD", monto: -20000,
        saldo_anterior: 100000, saldo_posterior: 80000, motivo: "Carga registrada por error"
    });

    const aCero = await servicio.ajustarSaldo(3, { moneda: "USD", tipo: "ajuste", saldoFinal: 0, motivo: "Corrección total" });
    assert.equal(estado.saldo, 0);
    assert.equal(aCero.movimiento.monto, -80000);
    assert.equal(aCero.movimiento.saldo_posterior, 0);
});

test("ajuste permite aumentar pero rechaza saldo negativo, motivo vacío y valor sin cambio", async t => {
    const { servicio, estado } = cargarServicio(t, { saldo: 50 });
    const aumento = await servicio.ajustarSaldo(3, { moneda: "USD", tipo: "ajuste", saldoFinal: 75, motivo: "Corrección de conteo" });
    assert.equal(aumento.movimiento.monto, 25);
    assert.equal(estado.saldo, 75);

    assert.deepEqual(await servicio.ajustarSaldo(3, { moneda: "USD", tipo: "ajuste", saldoFinal: -1, motivo: "Error" }), { error: "El nuevo saldo debe ser cero o positivo" });
    assert.deepEqual(await servicio.ajustarSaldo(3, { moneda: "USD", tipo: "ajuste", saldoFinal: 70, motivo: "  " }), { error: "El motivo del ajuste es obligatorio" });
    assert.deepEqual(await servicio.ajustarSaldo(3, { moneda: "USD", tipo: "ajuste", saldoFinal: 75, motivo: "Sin cambio" }), { error: "El nuevo saldo debe ser diferente del saldo actual" });
    assert.equal(estado.saldo, 75);
});

test("completar dos veces es idempotente y nunca duplica el descuento", async t => {
    const { servicio, estado } = cargarServicio(t, { saldo: 150 });
    await servicio.completarConDescuento(10, 3);
    const segunda = await servicio.completarConDescuento(10, 3);
    assert.equal(segunda, null);
    assert.equal(estado.saldo, 50);
    assert.equal(estado.movimientos.filter(m => m.tipo === "descuento").length, 1);
});

test("revertir una completada reintegra exactamente una vez", async t => {
    const descuento = { tipo: "descuento", operation_id: 10, moneda: "USD", monto: -100 };
    const { servicio, estado } = cargarServicio(t, { saldo: 50, status: "completada", movimientos: [descuento] });
    estado.operadorId = 3;
    const primera = await servicio.reintegrarPorReversion(10);
    const segunda = await servicio.reintegrarPorReversion(10);
    assert.deepEqual(primera, { reintegrado: 100, moneda: "USD", saldo: 150 });
    assert.equal(segunda, null);
    assert.equal(estado.saldo, 150);
    assert.equal(estado.movimientos.filter(m => m.tipo === "reintegro").length, 1);
});
