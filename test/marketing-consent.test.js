"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const consent = require("../src/services/marketing-consent");

test("la migración agrega alcance y revocación sin asignar consentimientos históricos", () => {
    const migration = fs.readFileSync(path.join(__dirname, "../migrations/0042_marketing_consent_scope_audit.sql"), "utf8");
    assert.match(migration, /marketing_consent_scope TEXT/);
    assert.match(migration, /marketing_consent_revoked_at TIMESTAMPTZ/);
    assert.doesNotMatch(migration, /UPDATE customers/i);
});

test("solo frases afirmativas exactas, en español o portugués, constituyen opt-in", () => {
    assert.equal(consent.isExplicitOptIn("ACEPTO PROMOCIONES"), true);
    assert.equal(consent.isExplicitOptIn("Aceito promoções."), true);
    assert.equal(consent.isExplicitOptIn("acepto mensajes comerciales"), true);
    assert.equal(consent.isExplicitOptIn("quiero cotizar"), false);
    assert.equal(consent.isExplicitOptIn("sí"), false);
    assert.equal(consent.isExplicitOptIn("no quiero promociones"), false);
});

test("el consentimiento queda asociado a una fuente y messageId verificables, y revoca un opt-out anterior", async () => {
    const calls = [];
    const db = { async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{ phone: params[0] }] };
    } };
    const recorded = await consent.recordExplicitOptIn({ phone: "5511999990000", messageId: "wa-123", text: "ACEPTO PROMOCIONES" }, db);
    assert.equal(recorded, true);
    assert.match(calls[0].sql, /marketing_opt_out=FALSE/);
    assert.match(calls[0].sql, /marketing_consent_message_id=\$2/);
    assert.match(calls[0].sql, /marketing_consent_scope='GENERAL_MARKETING'/);
    assert.equal(calls[0].params[1], "wa-123");
    assert.match(calls[1].sql, /MARKETING_CONSENT_RECORDED/);
    assert.match(calls[1].params[1], /GENERAL_MARKETING/);
});

test("un STOP guarda evidencia de revocación y alcance sin convertirlo en preferencia operativa", async () => {
    const calls = [];
    const db = { async query(sql, params) { calls.push({ sql, params }); return { rows: [{ phone: params[0] }] }; } };
    const recorded = await consent.recordExplicitOptOut({ phone: "5511999990000", messageId: "wa-stop-9", text: "STOP" }, db);
    assert.equal(recorded, true);
    assert.match(calls[0].sql, /marketing_opt_out=TRUE/);
    assert.match(calls[0].sql, /marketing_consent_revoked_at=NOW\(\)/);
    assert.match(calls[1].params[1], /GENERAL_MARKETING/);
    assert.match(calls[1].params[1], /wa-stop-9/);
    assert.equal(consent.isExplicitOptOut("quiero cancelar PIX"), false);
});
