"use strict";

const pool = require("../../db");

function isExplicitOptIn(text) {
    const normalized = String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
    return /^(acepto|aceito) (promociones|promocoes|mensajes comerciales|mensagens comerciais)[.!]?$/i.test(normalized);
}

function isExplicitOptOut(text) {
    return require("./commercial-contact-memory").isCommercialOptOut(text);
}

async function recordExplicitOptIn({ phone, messageId, text }, db = pool) {
    if (!phone || !isExplicitOptIn(text)) return false;
    const result = await db.query(`UPDATE customers SET marketing_opt_out=FALSE,
        marketing_consent_at=NOW(), marketing_consent_source='WHATSAPP_EXPLICIT_KEYWORD',
        marketing_consent_message_id=$2, marketing_consent_scope='GENERAL_MARKETING',
        marketing_consent_revoked_at=NULL, marketing_consent_revoked_source=NULL,
        marketing_consent_revoked_message_id=NULL, updated_at=NOW() WHERE phone=$1 RETURNING phone`,
    [phone, String(messageId || "").slice(0, 200) || null]);
    if (!result.rows[0]) return false;
    await db.query(`INSERT INTO commercial_outbound_events(event_type,actor,details)
        VALUES('MARKETING_CONSENT_RECORDED',$1,$2::jsonb)`,
    [`customer:${phone}`, JSON.stringify({ source: "WHATSAPP_EXPLICIT_KEYWORD", channel: "WHATSAPP", scope: "GENERAL_MARKETING", evidence: "EXACT_AFFIRMATIVE_KEYWORD", messageId: String(messageId || "").slice(0, 200) || null })]);
    return true;
}

async function recordExplicitOptOut({ phone, messageId, text }, db = pool) {
    if (!phone || !isExplicitOptOut(text)) return false;
    const id = String(messageId || "").slice(0, 200) || null;
    const result = await db.query(`UPDATE customers SET marketing_opt_out=TRUE,
        marketing_consent_revoked_at=NOW(), marketing_consent_revoked_source='WHATSAPP_CUSTOMER_REQUEST',
        marketing_consent_revoked_message_id=$2, updated_at=NOW() WHERE phone=$1 RETURNING phone`, [phone, id]);
    if (!result.rows[0]) return false;
    await db.query(`INSERT INTO commercial_outbound_events(event_type,actor,details)
        VALUES('MARKETING_CONSENT_REVOKED',$1,$2::jsonb)`,
    [`customer:${phone}`, JSON.stringify({ source: "WHATSAPP_CUSTOMER_REQUEST", channel: "WHATSAPP", scope: "GENERAL_MARKETING", evidence: "CUSTOMER_OPT_OUT", messageId: id })]);
    return true;
}

module.exports = { isExplicitOptIn, isExplicitOptOut, recordExplicitOptIn, recordExplicitOptOut };
