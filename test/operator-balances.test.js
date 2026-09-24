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
                estado.movimientos.push({ tipo, operation_id: 10, moneda: params[1], monto: Number(params[2]) });
                return { rows: [{ id: estado.movimientos.length }] };
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
