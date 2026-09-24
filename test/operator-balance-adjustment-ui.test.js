"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dashboard = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");

test("Operadores separa cargar saldo de ajustar saldo final", () => {
    assert.match(dashboard, />💰 Cargar saldo</);
    assert.match(dashboard, />⚖️ Ajustar saldo</);
    assert.match(dashboard, /tipo: "ajuste", saldoFinal, motivo/);
});

test("confirmación del ajuste muestra actual, nuevo, diferencia y motivo", () => {
    assert.match(dashboard, /Saldo actual: \$\{saldoActual\.toLocaleString/);
    assert.match(dashboard, /Nuevo saldo: \$\{saldoFinal\.toLocaleString/);
    assert.match(dashboard, /Diferencia: \$\{signo\}\$\{diferencia\.toLocaleString/);
    assert.match(dashboard, /Motivo: \$\{motivo\}/);
});

test("historial visible incluye el motivo cuando existe", () => {
    assert.match(dashboard, /m\.motivo \? ` · motivo: \$\{m\.motivo\}`/);
});
