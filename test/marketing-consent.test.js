"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const consent = require("../src/services/marketing-consent");

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
    assert.equal(calls[0].params[1], "wa-123");
    assert.match(calls[1].sql, /MARKETING_CONSENT_RECORDED/);
});
