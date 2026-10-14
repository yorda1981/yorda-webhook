"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const memory = require("../src/services/commercial-contact-memory");

function dbMock({ optedOut = false } = {}) {
    const events = [];
    const queries = [];
    const db = {
        events, queries,
        async connect() {
            return {
                async query(sql, params = []) {
                    queries.push({ sql: String(sql), params });
                    if (/SELECT COALESCE\(marketing_opt_out/.test(sql)) return { rows: [{ marketing_opt_out: optedOut }] };
                    if (/SELECT id FROM operations/.test(sql)) return { rows: [] };
                    if (/SELECT id, source, reason, strategy, provider_status/.test(sql)) return { rows: [] };
                    if (/INSERT INTO commercial_contact_events/.test(sql)) {
                        const id = events.length + 1;
                        events.push({ id, phone: params[0], status: "SENDING" });
                        return { rows: [{ id }] };
                    }
                    return { rows: [] };
                }, release() {}
            };
        },
        async query(sql, params = []) {
            queries.push({ sql: String(sql), params });
            return { rows: [] };
        }
    };
    return db;
}

const contact = { phone: "5511999999999", source: "crm", reason: "quote_pending", strategy: "refresh_quote", content: "¿Quieres actualizar el cálculo?" };

test("contactos comerciales crean claim previo al proveedor y serializan por teléfono", async () => {
    const db = dbMock();
    const claim = await memory.claim(contact, db);
    assert.equal(claim.allowed, true);
    assert.ok(db.queries.some(q => /pg_advisory_xact_lock/.test(q.sql)));
    assert.equal(db.events[0].status, "SENDING");
});

test("una preferencia de no contacto excluye campañas comerciales", async () => {
    const db = dbMock({ optedOut: true });
    const claim = await memory.claim(contact, db);
    assert.deepEqual(claim, { allowed: false, code: "OPTED_OUT" });
    assert.equal(db.events.length, 0);
});

test("un resultado de proveedor fallido nunca se guarda como enviado", async () => {
    const db = dbMock();
    const status = await memory.settle(42, { sent: false, error: "Z-API error" }, db);
    assert.equal(status, "FAILED");
    assert.equal(db.queries.at(-1).params[1], "FAILED");
    assert.equal(db.queries.at(-1).params[2], "Z-API error");
});

test("reconoce solicitudes comerciales de baja en español, portugués e inglés", () => {
    assert.equal(memory.isCommercialOptOut("No quiero más mensajes"), true);
    assert.equal(memory.isCommercialOptOut("Stop"), true);
    assert.equal(memory.isCommercialOptOut("Não me mandem mensagens"), true);
    assert.equal(memory.isCommercialOptOut("Quiero cotizar R$210"), false);
});

test("la solicitud de no contacto se registra como rechazo y no solo como respuesta", async () => {
    const db = dbMock();
    await memory.markLatestResponse(contact.phone, db, "DECLINED");
    assert.match(db.queries[0].sql, /SET response_status = \$2/);
    assert.equal(db.queries[0].params[1], "DECLINED");
});
