"use strict";

const pool = require("../../db");

function isExplicitOptIn(text) {
    const normalized = String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
    return /^(acepto|aceito) (promociones|promocoes|mensajes comerciales|mensagens comerciais)[.!]?$/i.test(normalized);
}

async function recordExplicitOptIn({ phone, messageId, text }, db = pool) {
    if (!phone || !isExplicitOptIn(text)) return false;
    const result = await db.query(`UPDATE customers SET marketing_opt_out=FALSE,
        marketing_consent_at=NOW(), marketing_consent_source='WHATSAPP_EXPLICIT_KEYWORD',
        marketing_consent_message_id=$2, updated_at=NOW() WHERE phone=$1 RETURNING phone`,
    [phone, String(messageId || "").slice(0, 200) || null]);
    if (!result.rows[0]) return false;
    await db.query(`INSERT INTO commercial_outbound_events(event_type,actor,details)
        VALUES('MARKETING_CONSENT_RECORDED',$1,$2::jsonb)`,
    [`customer:${phone}`, JSON.stringify({ source: "WHATSAPP_EXPLICIT_KEYWORD", messageId: String(messageId || "").slice(0, 200) || null })]);
    return true;
}

module.exports = { isExplicitOptIn, recordExplicitOptIn };
