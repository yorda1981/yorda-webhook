"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const ui = fs.readFileSync("public/entregas.html", "utf8");
const dashboard = fs.readFileSync("public/dashboard.html", "utf8");
const migration = fs.readFileSync("migrations/0019_entregas_pago_frete_usdt.sql", "utf8");

test("migración 0019 crea frete, subtotal y total con restricciones correctas", () => {
    assert.match(migration, /ADD COLUMN IF NOT EXISTS frete_usdt NUMERIC NOT NULL DEFAULT 0/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS subtotal_usdt NUMERIC/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS total_usdt NUMERIC/);
    assert.match(migration, /frete_usdt_nonnegative/);
    assert.match(migration, /subtotal_usdt_nonnegative/);
    assert.match(migration, /total_usdt_nonnegative/);
});

for (const [nombre, html] of [["entregas", ui], ["dashboard", dashboard]]) {
    test(`${nombre}: muestra entregas + frete = total y recalcula al seleccionar/tasa/frete`, () => {
        assert.match(html, /Frete \(USDT\)/);
        assert.match(html, /entResumenPago/);
        assert.match(html, /subtotal \+ frete/);
        assert.match(html, /actualizarResumenPago\(\)/);
        assert.match(html, /freteUsdt/);
    });

    test(`${nombre}: envío de pago usa frete y el backend como autoridad`, () => {
        assert.match(html, /monedaPago: "USDT", freteUsdt/);
        assert.match(html, /TOTAL A PAGAR/);
    });

    test(`${nombre}: pago histórico sin desglose no muestra frete 0 inventado`, () => {
        assert.match(html, /Desglose de frete no disponible para este pago histórico/);
        assert.match(html, /pago\.subtotal_usdt != null && pago\.total_usdt != null/);
    });

    test(`${nombre}: ofrece Copiar comprobante solo con desglose y copia texto financiero limpio`, () => {
        assert.match(html, /Copiar comprobante/);
        assert.match(html, /comprobanteTextoParaCopiar/);
        assert.match(html, /navigator\.clipboard\.writeText\(texto\)/);
        assert.match(html, /Comprobante copiado/);
        assert.match(html, /pagoVisualizado = pago/);
    });
}
