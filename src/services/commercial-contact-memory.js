"use strict";

const pool = require("../../db");

function isCommercialOptOut(text) {
    const normalized = String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return /\b(stop|cancel\s*me|no\s+me\s+escribas|no\s+quiero\s+(?:mas\s+)?mensajes|dejen\s+de\s+escribirme|parar\s+mensajes|remover\s+mi\s+numero|no\s+me\s+contacten|nao\s+me\s+mande(?:m)?\s+mensagens|parar\s+mensagens|remova\s+meu\s+numero)\b/i.test(normalized);
}

/** Claim and serialize proactive commercial contact. Transactional bot replies
 * never use this gate. A successful identical strategy is not repeated unless
 * a caller can prove a new opportunity and supplies a new reason/strategy. */
async function claim({ phone, source, reason, strategy, content, operationId = null, metadata = {} }, db = pool) {
    if (!phone || !source || !reason || !strategy || !String(content || "").trim()) {
        return { allowed: false, code: "INVALID_CONTACT" };
    }
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [String(phone)]);
        const customer = await client.query(`
            SELECT COALESCE(marketing_opt_out, false) AS marketing_opt_out
            FROM customers WHERE phone = $1 FOR UPDATE
        `, [phone]);
        if (!customer.rows.length) {
            await client.query("ROLLBACK");
            return { allowed: false, code: "CUSTOMER_NOT_FOUND" };
        }
        if (customer.rows[0]?.marketing_opt_out) {
            await client.query("ROLLBACK");
            return { allowed: false, code: "OPTED_OUT" };
        }
        await client.query(`
            UPDATE commercial_contact_events SET response_status = 'NO_REPLY'
            WHERE phone = $1 AND provider_status = 'SENT' AND response_status = 'UNKNOWN'
              AND occurred_at <= NOW() - INTERVAL '22 hours'
        `, [phone]);
        const active = await client.query(`
            SELECT id FROM operations WHERE phone = $1 AND status IN ('pendiente','confirmada') LIMIT 1
        `, [phone]);
        if (active.rows.length) {
            await client.query("ROLLBACK");
            return { allowed: false, code: "ACTIVE_OPERATION" };
        }
        const recent = await client.query(`
            SELECT id, source, reason, strategy, provider_status
            FROM commercial_contact_events
            WHERE phone = $1 AND occurred_at > NOW() - INTERVAL '22 hours'
              AND provider_status IN ('SENDING','SENT','UNKNOWN')
            ORDER BY id DESC LIMIT 1
        `, [phone]);
        if (recent.rows[0]) {
            await client.query("ROLLBACK");
            return { allowed: false, code: "RECENT_COMMERCIAL_CONTACT", previous: recent.rows[0] };
        }
        const inserted = await client.query(`
            INSERT INTO commercial_contact_events
                (phone, source, reason, strategy, content, provider_status, operation_id, metadata)
            VALUES ($1,$2,$3,$4,$5,'SENDING',$6,$7::jsonb)
            RETURNING id
        `, [phone, source, reason, strategy, String(content), operationId, JSON.stringify(metadata || {})]);
        await client.query("COMMIT");
        return { allowed: true, id: inserted.rows[0].id };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
    } finally {
        client.release();
    }
}

async function settle(id, { sent, error = null }, db = pool) {
    const status = sent === true ? "SENT" : sent === false ? "FAILED" : "UNKNOWN";
    await db.query(`
        UPDATE commercial_contact_events
        SET provider_status = $2, provider_error = $3
        WHERE id = $1 AND provider_status = 'SENDING'
    `, [id, status, error ? String(error).slice(0, 1000) : null]);
    return status;
}

async function recent(phone, limit = 20, db = pool) {
    const r = await db.query(`
        SELECT id, occurred_at, source, reason, strategy, content,
               provider_status, response_status, operation_id, provider_error
        FROM commercial_contact_events WHERE phone = $1
        ORDER BY occurred_at DESC, id DESC LIMIT $2
    `, [phone, Math.min(100, Math.max(1, Number(limit) || 20))]);
    return r.rows;
}

async function markLatestResponse(phone, db = pool) {
    await db.query(`
        UPDATE commercial_contact_events
        SET response_status = 'REPLIED'
        WHERE id = (
            SELECT id FROM commercial_contact_events
            WHERE phone = $1 AND provider_status = 'SENT' AND response_status = 'UNKNOWN'
            ORDER BY occurred_at DESC, id DESC LIMIT 1
        )
    `, [phone]);
}

module.exports = { claim, settle, recent, markLatestResponse, isCommercialOptOut };
