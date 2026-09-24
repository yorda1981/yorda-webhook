"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");

test("informe vive dentro de Operadores, se abre por operador y puede ocultarse", () => {
    const inicio = html.indexOf("👷 Operadores de Transferencias");
    const panel = html.indexOf('id="opInformePanel"');
    const crm = html.indexOf('id="seccionCrmTransferencias"');
    assert.ok(panel > inicio && panel < crm);
    assert.match(html, /id="opInformePanel" style="display:none;"/);
    assert.match(html, /onclick="abrirInformeOperador\(\$\{op\.id\}\)"/);
    assert.match(html, /onclick="cerrarInformeOperador\(\)"/);
    assert.match(html, />📊 Informe \/ Cierre</);
});

test("panel conserva filtros y períodos rápidos con personalizado", () => {
    for (const id of ["opInfOperador", "opInfPeriodo", "opInfDesde", "opInfHasta", "opInfMoneda", "opInfEstado"]) assert.match(html, new RegExp(`id="${id}"`));
    for (const periodo of ["Hoy", "Esta semana", "Semana anterior", "Este mes", "Mes anterior", "Personalizado"]) assert.match(html, new RegExp(`>${periodo}<`));
    assert.match(html, /function aplicarPeriodoInforme\(periodo\)/);
});

test("tabla individual contiene las doce columnas operativas", () => {
    for (const titulo of ["Fecha/hora", "ID", "Cliente/teléfono", "Moneda", "BRL", "Destino", "Tarjeta/cuenta", "Estado", "Operador", "Saldo antes", "Débito", "Saldo después"]) assert.match(html, new RegExp(`>${titulo}<`));
});

test("cierre muestra componentes separados por moneda y diseño responsive/imprimible", () => {
    for (const etiqueta of ["Saldo inicial", "Cargas", "Ajustes", "Transferencias", "Reintegros", "Saldo final", "N.º transferencias"]) assert.match(html, new RegExp(etiqueta));
    assert.match(html, /@media \(max-width: 900px\).*\.op-informe-filtros/s);
    assert.match(html, /@media print/);
});

function funcionDelDashboard(nombre) {
    const inicio = html.indexOf(`function ${nombre}(`);
    const fin = html.indexOf("\n        }\n", inicio);
    return new Function(`${html.slice(inicio, fin)}\n        }\nreturn ${nombre};`)();
}

test("períodos rápidos calculan rangos inclusivos en fin de mes, cambio de año y domingo", () => {
    const rango = funcionDelDashboard("rangoPeriodoInforme");
    assert.deepEqual(rango("hoy", "2026-09-24"), { desde: "2026-09-24", hasta: "2026-09-24" });
    assert.deepEqual(rango("semana_actual", "2026-09-27"), { desde: "2026-09-21", hasta: "2026-09-27" });
    assert.deepEqual(rango("semana_actual", "2026-09-21"), { desde: "2026-09-21", hasta: "2026-09-21" });
    assert.deepEqual(rango("semana_anterior", "2026-01-01"), { desde: "2025-12-22", hasta: "2025-12-28" });
    assert.deepEqual(rango("mes_actual", "2026-09-24"), { desde: "2026-09-01", hasta: "2026-09-24" });
    assert.deepEqual(rango("mes_anterior", "2026-01-15"), { desde: "2025-12-01", hasta: "2025-12-31" });
    assert.deepEqual(rango("mes_anterior", "2024-03-31"), { desde: "2024-02-01", hasta: "2024-02-29" });
});

test("períodos usan America/Bahia, recargan al cambiar y el cierre respeta la moneda filtrada", () => {
    assert.match(html, /timeZone: "America\/Bahia"/);
    assert.match(html, /rangoPeriodoInforme\(periodo, hoyInformeISO\(\)\)/);
    assert.match(html, /d\.cierre\.filter\(c => c\.moneda === d\.filtros\.moneda\)/);
});
