"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pool = require("../db");
const crm = require("../src/services/crm");

const FILA = {
    nuevos: "0", cotizados_hoy: "0", cotizados: "0",
    esperando_pix: "0", esperando_comprobante: "0",
    completados: "0", abandonos: "0", frecuentes: "0",
    cierres_hoy: "0", conversion_hoy: null, conversion_pct: null
};

async function sqlDeResumen(t) {
    let sql = "";
    t.mock.method(pool, "query", async consulta => {
        sql = consulta;
        return { rows: [FILA] };
    });
    await crm.obtenerEstadisticasCRM(30);
    return sql;
}

function bloqueCierres(sql) {
    return sql.match(/cierres AS \(([\s\S]*?)\)\s*SELECT clientes/)[1];
}

function bloqueEmbudo(sql) {
    return sql.match(/embudo AS \(([\s\S]*?)\),\s*cierres/)[1];
}

test("Cierres Hoy usa completed_at, así una operación creada ayer y completada hoy cuenta", async t => {
    const sql = await sqlDeResumen(t);
    const cierres = bloqueCierres(sql);
    assert.match(cierres, /completed_at\s*>=\s*limites_hoy\.inicio_utc/);
    assert.match(cierres, /completed_at\s*<\s*limites_hoy\.fin_utc/);
    assert.doesNotMatch(cierres, /created_at/);
});

test("Cierres Hoy no cuenta una operación solo por haber sido creada hoy ni una completada ayer", async t => {
    const cierres = bloqueCierres(await sqlDeResumen(t));
    assert.doesNotMatch(cierres, /created_at|updated_at|confirmed_at/);
    assert.match(cierres, />=\s*limites_hoy\.inicio_utc/);
    assert.match(cierres, /<\s*limites_hoy\.fin_utc/);
});

test("Cierres Hoy incluye Transferencias, Entregas y Recargas sin filtros por tipo", async t => {
    const cierres = bloqueCierres(await sqlDeResumen(t));
    assert.doesNotMatch(cierres, /\btipo\b|cup_efectivo|recarga_/i);
    assert.match(cierres, /FROM operations/);
});

test("Cierres Hoy cuenta cada Entrega una sola vez: no une operations con entregas", async t => {
    const cierres = bloqueCierres(await sqlDeResumen(t));
    assert.doesNotMatch(cierres, /JOIN\s+entregas/i);
    assert.match(cierres, /SELECT COUNT\(\*\) AS cierres_hoy\s+FROM operations/);
});

test("los límites son el día calendario de America/Sao_Paulo convertido a UTC", async t => {
    const sql = await sqlDeResumen(t);
    assert.match(sql, /NOW\(\) AT TIME ZONE 'America\/Sao_Paulo'/);
    assert.match(sql, /date_trunc\('day'/);
    assert.match(sql, /INTERVAL '1 day'/);
    assert.match(sql, /timezone\(\s*'UTC'/);
    assert.doesNotMatch(bloqueCierres(sql), /INTERVAL '24 hours'/);
});

test("Cotizados Hoy usa fecha_cotizacion y sigue contando aunque el cliente avance de estado", async t => {
    const sql = await sqlDeResumen(t);
    const filtro = sql.match(/COUNT\(\*\) FILTER \(\s*WHERE fecha_cotizacion([\s\S]*?)\)\s+AS cotizados_hoy/)[1];
    assert.match(filtro, />=\s*limites_hoy\.inicio_utc/);
    assert.match(filtro, /<\s*limites_hoy\.fin_utc/);
    assert.doesNotMatch(filtro, /estado_crm|updated_at/);
});

test("Conversión Hoy no inventa una asociación por phone y se devuelve sin dato", async t => {
    const sql = await sqlDeResumen(t);
    assert.match(sql, /NULL::numeric AS conversion_hoy/);
    assert.doesNotMatch(sql, /operations\.phone\s*=\s*customers\.phone/i);
});

test("El embudo usa una ventana común de 30 días y fechas reales", async t => {
    const sql = await sqlDeResumen(t);
    const embudo = bloqueEmbudo(sql);
    assert.match(embudo, /FROM customers\s+WHERE created_at >= NOW\(\) - INTERVAL '30 days'/);
    assert.match(embudo, /c\.fecha_cotizacion >= c\.created_at/);
    assert.match(embudo, /o\.created_at >= c\.created_at/);
    assert.match(embudo, /o\.confirmed_at >= o\.created_at/);
    assert.match(embudo, /o\.completed_at >= o\.confirmed_at/);
});

test("Las cinco etapas del embudo cuentan clientes únicos de la cohorte", async t => {
    const embudo = bloqueEmbudo(await sqlDeResumen(t));
    assert.match(embudo, /WITH cohorte AS/);
    assert.match(embudo, /COUNT\(\*\) FILTER \(WHERE cotizado AND operacion\)/);
    assert.match(embudo, /COUNT\(\*\) FILTER \(WHERE cotizado AND operacion AND confirmado\)/);
    assert.match(embudo, /AS contactos_nuevos/);
    assert.match(embudo, /AS cotizados/);
    assert.match(embudo, /AS operaciones_creadas/);
    assert.match(embudo, /AS pagos_confirmados/);
    assert.match(embudo, /AS completadas/);
    assert.doesNotMatch(embudo, /estado_crm/);
});

test("La progresión exige fechas válidas y no cuenta hitos anteriores al contacto", async t => {
    const embudo = bloqueEmbudo(await sqlDeResumen(t));
    assert.match(embudo, /fecha_cotizacion >= c\.created_at/);
    assert.match(embudo, /o\.created_at >= c\.created_at/);
    assert.match(embudo, /o\.confirmed_at >= o\.created_at/);
    assert.match(embudo, /o\.completed_at >= o\.confirmed_at/);
    assert.match(embudo, /cotizado AND operacion AND confirmado AND completado/);
});

test("Los porcentajes del embudo usan el denominador de la etapa anterior", async t => {
    const embudo = bloqueEmbudo(await sqlDeResumen(t));
    assert.match(embudo, /cotizados \/ NULLIF\(contactos_nuevos, 0\)/);
    assert.match(embudo, /operaciones_creadas \/ NULLIF\(cotizados, 0\)/);
    assert.match(embudo, /pagos_confirmados \/ NULLIF\(operaciones_creadas, 0\)/);
    assert.match(embudo, /completadas \/ NULLIF\(pagos_confirmados, 0\)/);
});

test("El embudo ya no contiene estados operativos ni abandonos", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    assert.doesNotMatch(html, /label: "[^\n]*Esperando PIX/);
    assert.doesNotMatch(html, /label: "[^\n]*Esperando Comprobante/);
    assert.doesNotMatch(html, /label: "[^\n]*Abandonos/);
    assert.match(html, /Contactos nuevos/);
    assert.match(html, /Operaciones creadas/);
    assert.match(html, /Pagos confirmados/);
});

test("El mini-indicador Nuevos Hoy duplicado fue retirado", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    assert.doesNotMatch(html, /Nuevos Hoy/);
    assert.doesNotMatch(html, /stat-nuevos-hoy/);
});

test("Los bloques del dashboard comparten colapsado visual persistente", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    assert.match(html, /dashboard\.collapsed\./);
    assert.match(html, /localStorage\.getItem\(storageKey\)/);
    assert.match(html, /dashboard-section-toggle/);
    assert.match(html, /aria-controls/);
    assert.match(html, /dashboard-section-collapsed/);
    assert.match(html, /let cerrado = false;/);
    assert.match(html, /localStorage\.getItem\(key\) === "1"/);
});

test("las etiquetas de teléfonos distinguen cliente/pagador y receptor sin cambiar ids", () => {
    const dashboard = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    const calculadora = fs.readFileSync(path.join(__dirname, "..", "public", "calculadora.html"), "utf8");

    assert.match(dashboard, /WhatsApp del cliente\/pagador \*/);
    assert.match(dashboard, /Recibe confirmaciones y avisos sobre la operación\./);
    assert.match(dashboard, /Teléfono del receptor en Cuba/);
    assert.match(dashboard, /Se utiliza para coordinar la entrega del efectivo\./);
    assert.match(dashboard, /id="manWhatsapp"/);
    assert.match(dashboard, /id="manTelefonoEntrega"/);

    assert.match(calculadora, /lblWhatsappCliente:"WhatsApp del cliente\/pagador \(opcional\)"/);
    assert.match(calculadora, /lblTelefonoReq:"Teléfono del receptor en Cuba"/);
    assert.match(calculadora, /id="inWhatsappCliente"/);
    assert.match(calculadora, /id="inTelefonoReq"/);
});
