"use strict";

const crypto = require("node:crypto");
const pool = require("../../db");

const REFERRAL_CODE_RE = /^[A-Z0-9]{10}$/;
const VALID_REMITTANCE_TYPES = ["brl_cup", "cup_transferencia"];
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const normalizeCode = value => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const phoneDigits = value => String(value || "").replace(/\D/g, "");

function randomCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.randomBytes(7);
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    return Array.from({ length: 10 }, (_, index) => alphabet[Number((value >> BigInt(51 - index * 5)) & 31n)]).join("");
}

async function ensureReferralCode(phone, db = pool, generate = randomCode) {
    if (!phone) throw new Error("Teléfono requerido");
    const program = await db.query("SELECT enabled FROM referral_program_config WHERE id = 1");
    if (!program.rows[0]?.enabled) return null;
    for (let attempt = 0; attempt < 4; attempt++) {
        const code = generate();
        if (!REFERRAL_CODE_RE.test(code)) throw new Error("Generador de código inválido");
        try {
            const result = await db.query(`
                UPDATE customers SET referral_code = COALESCE(referral_code, $2), updated_at = NOW()
                WHERE phone = $1 RETURNING referral_code
            `, [phone, code]);
            if (!result.rows[0]) return null;
            return result.rows[0].referral_code;
        } catch (error) {
            if (error.code !== "23505" || attempt === 3) throw error;
        }
    }
    return null;
}

async function getProgramConfig(db = pool) {
    const result = await db.query("SELECT * FROM referral_program_config WHERE id = 1");
    return result.rows[0] || { enabled: false, reward_pct: 1, max_reward_brl: null, campaign_limit_brl: null, period_limit_brl: null };
}

async function saveProgramConfig(input, actor, db = pool) {
    const enabled = input.enabled === true;
    const rewardPct = Number(input.rewardPct ?? 1);
    const optionalAmount = value => value == null || value === "" ? null : Number(value);
    const maxReward = optionalAmount(input.maxRewardBRL);
    const campaignLimit = optionalAmount(input.campaignLimitBRL);
    const periodLimit = optionalAmount(input.periodLimitBRL);
    const unknownNetProfitAcknowledged = input.acknowledgeUnknownNetProfit === true;
    if (rewardPct !== 1) throw Object.assign(new Error("La regla aprobada de este programa es una recompensa fija del 1 %"), { status: 400 });
    for (const value of [maxReward, campaignLimit, periodLimit]) {
        if (value !== null && (!Number.isFinite(value) || value <= 0)) throw Object.assign(new Error("Los límites deben ser importes positivos o quedar sin configurar"), { status: 400 });
    }
    if (enabled && [maxReward, campaignLimit, periodLimit].some(value => value === null)) {
        throw Object.assign(new Error("Para activar el programa configura el máximo por recompensa, presupuesto de campaña y presupuesto mensual"), { status: 409, code: "LIMITS_REQUIRED" });
    }
    if (enabled && !unknownNetProfitAcknowledged) {
        throw Object.assign(new Error("Los costos netos no están verificados. Para activar, reconoce expresamente que la rentabilidad neta seguirá siendo desconocida."), { status: 409, code: "UNKNOWN_NET_PROFIT_ACK_REQUIRED" });
    }
    const result = await db.query(`
        UPDATE referral_program_config
        SET enabled = $1, reward_pct = $2, max_reward_brl = $3,
            campaign_limit_brl = $4, period_limit_brl = $5, unknown_net_profit_acknowledged = $7,
            enabled_at = CASE WHEN $1 AND NOT enabled THEN NOW() WHEN NOT $1 THEN NULL ELSE enabled_at END,
            updated_at = NOW(), updated_by = $6
        WHERE id = 1 RETURNING *
    `, [enabled, rewardPct, maxReward, campaignLimit, periodLimit, actor || "admin", unknownNetProfitAcknowledged]);
    return result.rows[0];
}

async function recordReferralLink({ referredPhone, code, evidence = "WHATSAPP_CODE", evidenceNote = null, actor = null }, db = pool) {
    const referralCode = normalizeCode(code);
    if (!referredPhone || !REFERRAL_CODE_RE.test(referralCode)) return { linked: false, reason: "INVALID_CODE_FORMAT" };
    if (!["WHATSAPP_CODE", "ADMIN_VERIFIED"].includes(evidence)) return { linked: false, reason: "INVALID_EVIDENCE" };
    evidenceNote = String(evidenceNote || "").trim().slice(0, 500) || null;
    if (evidence === "ADMIN_VERIFIED" && !evidenceNote) return { linked: false, reason: "EVIDENCE_REQUIRED" };
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const locks = [`referral-code:${referralCode}`, `referral-person:${referredPhone}`].sort();
        for (const lock of locks) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
        const config = await client.query("SELECT enabled, reward_pct FROM referral_program_config WHERE id = 1 FOR SHARE");
        if (!config.rows[0]?.enabled) {
            await client.query("ROLLBACK");
            return { linked: false, reason: "PROGRAM_INACTIVE" };
        }
        const customer = await client.query("SELECT phone FROM customers WHERE phone = $1 FOR UPDATE", [referredPhone]);
        if (!customer.rows[0]) {
            await client.query("ROLLBACK");
            return { linked: false, reason: "CUSTOMER_NOT_FOUND" };
        }
        const referrer = await client.query("SELECT phone FROM customers WHERE referral_code = $1 FOR SHARE", [referralCode]);
        if (!referrer.rows[0]) {
            await client.query("ROLLBACK");
            return { linked: false, reason: "UNKNOWN_CODE" };
        }
        if (referrer.rows[0].phone === referredPhone || phoneDigits(referrer.rows[0].phone) === phoneDigits(referredPhone)) {
            await client.query("ROLLBACK");
            return { linked: false, reason: "SELF_REFERRAL" };
        }
        const prior = await client.query(`SELECT id FROM operations WHERE phone = $1 AND status = 'completada'
            AND tipo = ANY($2::text[]) AND monto > 0 AND COALESCE(es_prueba,FALSE) = FALSE LIMIT 1`, [referredPhone, VALID_REMITTANCE_TYPES]);
        if (prior.rows.length) {
            await client.query("ROLLBACK");
            return { linked: false, reason: "ALREADY_COMPLETED_REMITTANCE" };
        }
        const existing = await client.query("SELECT id, referrer_phone FROM customer_referrals WHERE referred_phone = $1 FOR UPDATE", [referredPhone]);
        if (existing.rows[0]) {
            await client.query("ROLLBACK");
            return { linked: false, reason: "ALREADY_LINKED", referralId: existing.rows[0].id };
        }
        const inserted = await client.query(`
            INSERT INTO customer_referrals (referral_code, referrer_phone, referred_phone, evidence, evidence_note, reward_pct, status_reason)
            VALUES ($1,$2,$3,$4,$5,$6,'Esperando primera remesa válida completada') RETURNING *
        `, [referralCode, referrer.rows[0].phone, referredPhone, evidence, String(evidenceNote || "").trim() || null, config.rows[0].reward_pct]);
        const row = inserted.rows[0];
        await client.query(`INSERT INTO customer_referral_events (referral_id, actor, action, to_status, details)
            VALUES ($1,$2,'VINCULACION_CREADA',$3,$4::jsonb)`,
        [row.id, actor || (evidence === "WHATSAPP_CODE" ? "whatsapp" : "admin"), row.status, JSON.stringify({ evidence, evidenceNote: row.evidence_note })]);
        await client.query("COMMIT");
        return { linked: true, referralId: row.id, status: row.status };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        if (error.code === "23505") return { linked: false, reason: "ALREADY_LINKED_OR_DUPLICATE" };
        throw error;
    } finally { client.release(); }
}

async function processReferralCodeMessage(phone, text, db = pool) {
    const raw = String(text || "").trim();
    const askCode = /^(?:mi|meu)\s+(?:c[oó]digo|codigo)\s+(?:de\s+)?(?:referidos?|indica[cç][aã]o)\s*\??$/i.test(raw);
    const match = raw.match(/\b(?:me\s+recomend[oó]|vengo\s+(?:recomendad[oa]\s+)?por|indica[cç][aã]o|referid[oa]\s+por|c[oó]digo\s+(?:de\s+)?referid[oa])\s*[:#-]?\s*([A-Z0-9]{10})\b/i);
    if (!askCode && !match) return { handled: false };
    await db.query(`INSERT INTO customers (phone, created_at, updated_at) VALUES ($1,NOW(),NOW())
        ON CONFLICT (phone) DO NOTHING`, [phone]);
    if (askCode) {
        const config = await getProgramConfig(db);
        if (!config.enabled) return { handled: true, message: "El programa de referidos todavía no está activo. No compartas códigos por ahora." };
        const code = await ensureReferralCode(phone, db);
        return { handled: true, message: code
            ? `Tu código único de referido es *${code}*. Si una persona nueva completa su primera remesa válida mientras el programa esté activo, podrías recibir una recompensa única del 1 %, sujeta a validación y aprobación. No se paga automáticamente.`
            : "No encontré tu registro para generar el código. Escríbenos y lo revisamos." };
    }
    const result = await recordReferralLink({ referredPhone: phone, code: match[1], evidenceNote: "Código comunicado directamente por el cliente por WhatsApp" }, db);
    const messages = {
        PROGRAM_INACTIVE: "Gracias por contarnos. El programa de referidos todavía no está activo, así que no puedo registrar una recompensa ahora.",
        UNKNOWN_CODE: "No pude validar ese código. Comprueba los 10 caracteres o pide a quien te recomendó que confirme su código.",
        SELF_REFERRAL: "El código no se puede utilizar para recomendarte a ti mismo.",
        ALREADY_COMPLETED_REMITTANCE: "No puedo vincular un referido después de que ya se completó una remesa; no hacemos asociaciones retroactivas.",
        ALREADY_LINKED: "Ya existe una referencia registrada para este número. No se puede cambiar automáticamente.",
        ALREADY_LINKED_OR_DUPLICATE: "La referencia ya estaba registrada o existe un registro duplicado; no se cambió el referente."
    };
    return { handled: true, linked: result.linked, message: result.linked
        ? "Referencia registrada. Si completas tu primera remesa válida, la recompensa del referente pasa a revisión; no se activa ni paga automáticamente."
        : (messages[result.reason] || "No pude registrar la referencia. Escríbenos para que el equipo la revise.") };
}

async function onOperationCompleted(operation, db = pool) {
    if (!operation || !VALID_REMITTANCE_TYPES.includes(operation.tipo) || !(Number(operation.monto) > 0)) return { processed: false, reason: "NOT_ELIGIBLE_REMITTANCE" };
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`referral-person:${operation.phone}`]);
        const first = await client.query(`SELECT id, monto, tipo, completed_at FROM operations
            WHERE phone = $1 AND status = 'completada' AND tipo = ANY($2::text[]) AND monto > 0 AND COALESCE(es_prueba,FALSE) = FALSE
            ORDER BY completed_at ASC NULLS LAST, id ASC LIMIT 1`, [operation.phone, VALID_REMITTANCE_TYPES]);
        if (Number(first.rows[0]?.id) !== Number(operation.id)) {
            await client.query("COMMIT");
            return { processed: false, reason: "NOT_FIRST_REMITTANCE" };
        }
        const referral = await client.query("SELECT * FROM customer_referrals WHERE referred_phone = $1 FOR UPDATE", [operation.phone]);
        if (!referral.rows[0] || referral.rows[0].status !== "PENDIENTE") {
            await client.query("COMMIT");
            return { processed: false, reason: referral.rows[0]?.status || "NO_REFERRAL" };
        }
        const row = referral.rows[0];
        await client.query("SELECT pg_advisory_xact_lock(hashtext('referral-program-budget'))");
        const config = await client.query("SELECT * FROM referral_program_config WHERE id = 1 FOR SHARE");
        const cfg = config.rows[0] || {};
        const amount = money(first.rows[0].monto);
        const reward = money(amount * Number(row.reward_pct) / 100);
        let reviewReason = null;
        if ([cfg.max_reward_brl, cfg.campaign_limit_brl, cfg.period_limit_brl].some(value => value == null)) reviewReason = "Faltan límites económicos configurados; requiere revisión humana";
        else if (!(amount > 0) || !(reward > 0)) reviewReason = "Importe o recompensa no válidos";
        else if (cfg.max_reward_brl != null && reward > Number(cfg.max_reward_brl)) reviewReason = "Supera el límite configurado por recompensa";
        else {
            const usage = await client.query(`SELECT COALESCE(SUM(reward_brl),0) AS total FROM customer_referrals
                WHERE status IN ('ELEGIBLE','APROBADA','LIQUIDADA','REVISION_REVERSO') AND eligible_at >= COALESCE($1, '-infinity'::timestamptz)`, [cfg.enabled_at]);
            const campaignTotal = Number(usage.rows[0]?.total || 0) + reward;
            if (cfg.campaign_limit_brl != null && campaignTotal > Number(cfg.campaign_limit_brl)) reviewReason = "Supera el límite acumulado configurado para el programa";
            const period = await client.query(`SELECT COALESCE(SUM(reward_brl),0) AS total FROM customer_referrals
                WHERE status IN ('ELEGIBLE','APROBADA','LIQUIDADA','REVISION_REVERSO') AND eligible_at >= date_trunc('month', NOW())`);
            if (!reviewReason && cfg.period_limit_brl != null && Number(period.rows[0]?.total || 0) + reward > Number(cfg.period_limit_brl)) reviewReason = "Supera el límite mensual configurado";
        }
        const nextStatus = reviewReason ? "REVISION" : "ELEGIBLE";
        await client.query(`UPDATE customer_referrals SET first_operation_id = $2, first_amount_brl = $3,
            reward_brl = $4, status = $5, eligible_at = CASE WHEN $5 = 'ELEGIBLE' THEN NOW() ELSE eligible_at END,
            status_reason = $6, updated_at = NOW() WHERE id = $1`,
        [row.id, first.rows[0].id, amount, reward, nextStatus, reviewReason || "Primera remesa completada; requiere revisión humana"]);
        await client.query(`INSERT INTO customer_referral_events (referral_id, actor, action, from_status, to_status, details)
            VALUES ($1,'system','PRIMERA_REMESA_VALIDADA',$2,$3,$4::jsonb)`,
        [row.id, row.status, nextStatus, JSON.stringify({ operationId: first.rows[0].id, amountBRL: amount, rewardBRL: reward, reason: reviewReason })]);
        await client.query("COMMIT");
        return { processed: true, referralId: Number(row.id), status: nextStatus, amountBRL: amount, rewardBRL: reward, reason: reviewReason };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
    } finally { client.release(); }
}

async function reconcilePendingReferralAccruals(db = pool, limit = 100) {
    const pending = await db.query(`SELECT r.referred_phone AS phone, o.id, o.monto, o.tipo
        FROM customer_referrals r JOIN LATERAL (
            SELECT op.id, op.monto, op.tipo, op.completed_at FROM operations op
            WHERE op.phone = r.referred_phone AND op.status = 'completada'
              AND op.tipo = ANY($1::text[]) AND op.monto > 0
              AND COALESCE(op.es_prueba,FALSE) = FALSE AND op.completed_at >= r.linked_at
            ORDER BY op.completed_at ASC NULLS LAST, op.id ASC LIMIT 1
        ) o ON TRUE
        WHERE r.status = 'PENDIENTE' ORDER BY o.id LIMIT $2`,
    [VALID_REMITTANCE_TYPES, Math.min(500, Math.max(1, Number(limit) || 100))]);
    let processed = 0;
    for (const operation of pending.rows) {
        const result = await onOperationCompleted(operation, db);
        if (result.processed) processed++;
    }
    return { inspected: pending.rows.length, processed };
}

async function reviewReversedOperation(operationId, db = pool) {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const before = await client.query("SELECT * FROM customer_referrals WHERE first_operation_id = $1 FOR UPDATE", [operationId]);
        const row = before.rows[0];
        if (!row || !["ELEGIBLE", "APROBADA", "LIQUIDADA"].includes(row.status)) {
            await client.query("COMMIT");
            return null;
        }
        const next = row.status === "LIQUIDADA" ? "REVISION_REVERSO" : "CANCELADA";
        const updated = await client.query(`UPDATE customer_referrals SET status = $2,
            status_reason = 'La primera operación vinculada fue revertida; revisar recompensa manualmente',
            reversed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`, [row.id, next]);
        await client.query(`INSERT INTO customer_referral_events (referral_id, actor, action, from_status, to_status, details)
            VALUES ($1,'system','OPERACION_REVERTIDA',$2,$3,$4::jsonb)`,
        [row.id, row.status, next, JSON.stringify({ operationId })]);
        await client.query("COMMIT");
        return updated.rows[0];
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
    } finally { client.release(); }
}

async function transitionReferral(id, action, { actor = "admin", method = null, reference = null } = {}, db = pool) {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query("SELECT * FROM customer_referrals WHERE id = $1 FOR UPDATE", [id]);
        const row = result.rows[0];
        if (!row) throw Object.assign(new Error("Referencia no encontrada"), { status: 404 });
        const from = row.status;
        const transitions = {
            approve: { from: ["ELEGIBLE"], to: "APROBADA", action: "APROBADA" },
            validate: { from: ["REVISION"], to: "ELEGIBLE", action: "REVISION_VALIDADA" },
            reject: { from: ["PENDIENTE", "ELEGIBLE", "REVISION"], to: "RECHAZADA", action: "RECHAZADA" },
            cancel: { from: ["PENDIENTE"], to: "CANCELADA", action: "CANCELADA" },
            settle: { from: ["APROBADA"], to: "LIQUIDADA", action: "LIQUIDADA" }
        };
        const transition = transitions[action];
        if (!transition || !transition.from.includes(from)) throw Object.assign(new Error("Transición no permitida para el estado actual"), { status: 409 });
        if (action === "settle" && (!String(method || "").trim() || !String(reference || "").trim())) {
            throw Object.assign(new Error("La liquidación requiere método y referencia verificable"), { status: 400 });
        }
        if (action === "validate") {
            const cfgResult = await client.query("SELECT * FROM referral_program_config WHERE id = 1 FOR SHARE");
            const cfg = cfgResult.rows[0] || {};
            if ([cfg.max_reward_brl, cfg.campaign_limit_brl, cfg.period_limit_brl].some(value => value == null)) throw Object.assign(new Error("Faltan límites económicos configurados"), { status: 409 });
            if (!row.first_operation_id || !Number(row.reward_brl)) throw Object.assign(new Error("Falta validar la primera operación o el importe de la recompensa"), { status: 409 });
            if (cfg.max_reward_brl != null && Number(row.reward_brl) > Number(cfg.max_reward_brl)) throw Object.assign(new Error("La recompensa todavía excede el máximo configurado"), { status: 409 });
            await client.query("SELECT pg_advisory_xact_lock(hashtext('referral-program-budget'))");
            const campaign = await client.query(`SELECT COALESCE(SUM(reward_brl),0) AS total FROM customer_referrals
                WHERE status IN ('ELEGIBLE','APROBADA','LIQUIDADA','REVISION_REVERSO') AND eligible_at >= COALESCE($1, '-infinity'::timestamptz) AND id <> $2`, [cfg.enabled_at, id]);
            if (cfg.campaign_limit_brl != null && Number(campaign.rows[0]?.total || 0) + Number(row.reward_brl) > Number(cfg.campaign_limit_brl)) throw Object.assign(new Error("El límite acumulado del programa sigue excedido"), { status: 409 });
            const period = await client.query(`SELECT COALESCE(SUM(reward_brl),0) AS total FROM customer_referrals
                WHERE status IN ('ELEGIBLE','APROBADA','LIQUIDADA','REVISION_REVERSO') AND eligible_at >= date_trunc('month', NOW()) AND id <> $1`, [id]);
            if (cfg.period_limit_brl != null && Number(period.rows[0]?.total || 0) + Number(row.reward_brl) > Number(cfg.period_limit_brl)) throw Object.assign(new Error("El límite mensual sigue excedido"), { status: 409 });
        }
        const updated = await client.query(`UPDATE customer_referrals SET status = $2, status_reason = $3,
            eligible_at = CASE WHEN $2 = 'ELEGIBLE' THEN COALESCE(eligible_at, NOW()) ELSE eligible_at END,
            approved_at = CASE WHEN $2 = 'APROBADA' THEN NOW() ELSE approved_at END,
            approved_by = CASE WHEN $2 = 'APROBADA' THEN $4 ELSE approved_by END,
            settled_at = CASE WHEN $2 = 'LIQUIDADA' THEN NOW() ELSE settled_at END,
            settled_by = CASE WHEN $2 = 'LIQUIDADA' THEN $4 ELSE settled_by END,
            settlement_method = CASE WHEN $2 = 'LIQUIDADA' THEN $5 ELSE settlement_method END,
            settlement_reference = CASE WHEN $2 = 'LIQUIDADA' THEN $6 ELSE settlement_reference END,
            updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id, transition.to, action === "reject" ? "Rechazada por operador" : null, actor,
            String(method || "").trim() || null, String(reference || "").trim() || null]);
        await client.query(`INSERT INTO customer_referral_events
            (referral_id, actor, action, from_status, to_status, details)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [id, actor, transition.action, from, transition.to, JSON.stringify({ method, reference })]);
        await client.query("COMMIT");
        return updated.rows[0];
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
    } finally { client.release(); }
}

async function listReferrals({ status = null, limit = 100 } = {}, db = pool) {
    const result = await db.query(`SELECT r.*, ref.nombre AS referrer_name, new.nombre AS referred_name
        FROM customer_referrals r
        LEFT JOIN customers ref ON ref.phone = r.referrer_phone
        LEFT JOIN customers new ON new.phone = r.referred_phone
        WHERE ($1::text IS NULL OR r.status = $1)
        ORDER BY r.linked_at DESC, r.id DESC LIMIT $2`, [status, Math.min(250, Math.max(1, Number(limit) || 100))]);
    return result.rows;
}

const SECOND_TRANSFER_CTE = `WITH eligible AS (
    SELECT c.phone, c.nombre, c.tipo_favorito, c.fecha_cotizacion, first_op.tipo AS first_service_type, first_op.id AS first_operation_id,
           first_op.completed_at AS first_completed_at, first_op.monto AS first_amount_brl,
           (c.fecha_cotizacion > first_op.completed_at) AS has_quote_signal,
           EXISTS (SELECT 1 FROM bot_inbound_messages bi WHERE bi.phone = c.phone AND bi.recibido_at > first_op.completed_at) AS has_inbound_signal
    FROM customers c
    JOIN LATERAL (SELECT o.id, o.completed_at, o.monto, o.tipo FROM operations o
        WHERE o.phone = c.phone AND o.status = 'completada' AND o.tipo = ANY($1::text[]) AND o.monto > 0 AND COALESCE(o.es_prueba,FALSE) = FALSE
        ORDER BY o.completed_at ASC NULLS LAST, o.id ASC LIMIT 1) first_op ON TRUE
    WHERE first_op.completed_at <= NOW() - INTERVAL '7 days'
      AND first_op.completed_at >= NOW() - INTERVAL '45 days'
      AND (SELECT COUNT(*) FROM operations o WHERE o.phone = c.phone AND o.status = 'completada'
           AND o.tipo = ANY($1::text[]) AND o.monto > 0 AND COALESCE(o.es_prueba,FALSE) = FALSE) = 1
      AND (c.fecha_cotizacion > first_op.completed_at OR (c.estado_crm IN ('cotizado','esperando_pix') AND EXISTS (
          SELECT 1 FROM bot_inbound_messages bi WHERE bi.phone = c.phone AND bi.recibido_at > first_op.completed_at)))
      AND NOT COALESCE(c.marketing_opt_out, FALSE)
      AND (c.pausa_hasta IS NULL OR c.pausa_hasta <= NOW())
      AND NOT EXISTS (SELECT 1 FROM blocked_numbers b WHERE b.phone = c.phone)
      AND NOT EXISTS (SELECT 1 FROM operations active WHERE active.phone = c.phone AND active.status IN ('pendiente','confirmada'))
      AND NOT EXISTS (SELECT 1 FROM commercial_contact_events ce WHERE ce.phone = c.phone
          AND ce.provider_status IN ('SENDING','SENT','UNKNOWN') AND ce.occurred_at >= NOW() - INTERVAL '14 days')
      AND NOT EXISTS (SELECT 1 FROM customer_referrals cr WHERE cr.referred_phone = c.phone AND cr.status = 'PENDIENTE')
)`;

function followupMessage(row) {
    const name = String(row.nombre || "").trim().split(/\s+/)[0];
    const salutation = name ? `Hola ${name} 👋` : "Hola 👋";
    const signal = row.has_quote_signal
        ? "Vi que después volviste a consultar una cotización; puedo actualizarla con la información vigente."
        : "Veo que retomaste una cotización pendiente; puedo ayudarte a revisar el proceso y resolver cualquier duda. Tu operación no está activa ahora.";
    const service = row.first_service_type === "brl_cup" || row.first_service_type === "cup_transferencia" ? " a Cuba" : "";
    return `${salutation} Gracias por confiar en YORDA para tu primera remesa${service}. ${signal} Si tienes un nuevo envío en mente, dime y lo revisamos sin compromiso.`;
}

async function getSecondTransferCandidates({ limit = 100 } = {}, db = pool) {
    const result = await db.query(`${SECOND_TRANSFER_CTE}
        SELECT e.*, (e.has_quote_signal OR e.has_inbound_signal) AS reason_verified
        FROM eligible e ORDER BY e.first_completed_at DESC LIMIT $2`,
    [VALID_REMITTANCE_TYPES, Math.min(250, Math.max(1, Number(limit) || 100))]);
    return result.rows.map(row => ({
        ...row,
        preparedMessage: followupMessage(row),
        measurement: "segunda remesa completada posterior; respuesta y asociación registradas por separado, sin atribución causal automática"
    }));
}

async function getSecondTransferSummary(db = pool) {
    const result = await db.query(`${SECOND_TRANSFER_CTE} SELECT COUNT(*)::int AS count FROM eligible`, [VALID_REMITTANCE_TYPES]);
    return Number(result.rows[0]?.count || 0);
}

async function getReferralSummary(db = pool) {
    const result = await db.query(`SELECT
        COUNT(*)::int AS vinculados,
        COUNT(*) FILTER (WHERE status = 'PENDIENTE')::int AS esperando_primera_remesa,
        COUNT(*) FILTER (WHERE status = 'ELEGIBLE')::int AS elegibles,
        COUNT(*) FILTER (WHERE status = 'APROBADA')::int AS aprobadas,
        COUNT(*) FILTER (WHERE status = 'LIQUIDADA')::int AS liquidadas,
        COUNT(*) FILTER (WHERE status IN ('REVISION','REVISION_REVERSO'))::int AS en_revision,
        COALESCE(SUM(reward_brl) FILTER (WHERE status IN ('ELEGIBLE','APROBADA','LIQUIDADA','REVISION_REVERSO')),0)::numeric AS costo_comprometido_brl
        FROM customer_referrals`);
    return result.rows[0] || {};
}

async function getAcquisitionOverview(db = pool) {
    const [config, referrals, secondTransferCandidates] = await Promise.all([
        getProgramConfig(db), getReferralSummary(db), getSecondTransferSummary(db)
    ]);
    return { config, referrals, secondTransferCandidates,
        secondTransferWindow: "Una remesa válida hace 7–45 días, exactamente una remesa completada, e interés posterior comprobable; sin operación activa, opt-out, pausa, bloqueo ni contacto comercial enviado en 14 días.",
        referralEconomics: { rewardPct: Number(config.reward_pct || 1), maxRewardBRL: config.max_reward_brl == null ? null : Number(config.max_reward_brl), campaignLimitBRL: config.campaign_limit_brl == null ? null : Number(config.campaign_limit_brl), periodLimitBRL: config.period_limit_brl == null ? null : Number(config.period_limit_brl), netProfitKnown: false, unknownNetProfitAcknowledged: Boolean(config.unknown_net_profit_acknowledged) }
    };
}

module.exports = {
    REFERRAL_CODE_RE, VALID_REMITTANCE_TYPES, normalizeCode, randomCode,
    ensureReferralCode, getProgramConfig, saveProgramConfig, recordReferralLink,
    processReferralCodeMessage, onOperationCompleted, reviewReversedOperation,
    reconcilePendingReferralAccruals,
    transitionReferral, listReferrals, getReferralSummary,
    getSecondTransferCandidates, getSecondTransferSummary, getAcquisitionOverview, followupMessage
};
