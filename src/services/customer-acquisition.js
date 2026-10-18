"use strict";

const crypto = require("node:crypto");
const pool = require("../../db");
const env = require("../config/env");

const REFERRAL_CODE_RE = /^[A-Z0-9]{10}$/;
const VALID_REMITTANCE_TYPES = ["brl_cup", "cup_transferencia"];
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const normalizeCode = value => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const phoneDigits = value => String(value || "").replace(/\D/g, "");
const PILOT = Object.freeze({ rewardPct: 1, maxRewardBRL: 50, budgetBRL: 500, durationDays: 30, participationDays: 30 });

function programAcceptingReferrals(config, now = Date.now()) {
    return Boolean(config?.enabled && config?.expires_at && new Date(config.expires_at).getTime() > now);
}

function referralShareLink(code, officialNumber) {
    const number = phoneDigits(officialNumber);
    if (!number || !REFERRAL_CODE_RE.test(normalizeCode(code))) return null;
    const message = `Hola, quiero registrarme con código de referido ${normalizeCode(code)}`;
    return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

async function getOfficialWhatsAppNumber() {
    if (env.WHATSAPP_OFFICIAL_NUMBER) return phoneDigits(env.WHATSAPP_OFFICIAL_NUMBER);
    // El número de contacto oficial no está almacenado como variable separada:
    // obtenerlo del dispositivo conectado de Z-API evita usar el teléfono admin.
    const device = await require("./zapi").obtenerDispositivo();
    return phoneDigits(device?.phone || device?.phoneNumber || device?.connectedPhone || device?.number || "") || null;
}

async function recordLinkGenerated(phone, linkAvailable, db = pool) {
    await db.query(`INSERT INTO referral_program_events (customer_phone, action, details)
        VALUES ($1,'ENLACE_GENERADO',$2::jsonb)`, [phone, JSON.stringify({ linkAvailable: Boolean(linkAvailable) })]);
}

function randomCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.randomBytes(7);
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    return Array.from({ length: 10 }, (_, index) => alphabet[Number((value >> BigInt(51 - index * 5)) & 31n)]).join("");
}

async function ensureReferralCode(phone, db = pool, generate = randomCode) {
    if (!phone) throw new Error("Teléfono requerido");
    const program = await db.query("SELECT * FROM referral_program_config WHERE id = 1");
    if (!programAcceptingReferrals(program.rows[0])) return null;
    // Solicitar/compartir el enlace no crea una obligación económica. La
    // reserva completa del máximo se realiza al registrar cada referido.
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
    const rewardPct = Number(input.rewardPct ?? PILOT.rewardPct);
    const maxReward = Number(input.maxRewardBRL ?? PILOT.maxRewardBRL);
    const campaignLimit = Number(input.campaignLimitBRL ?? PILOT.budgetBRL);
    const periodLimit = Number(input.periodLimitBRL ?? PILOT.budgetBRL);
    const unknownNetProfitAcknowledged = input.acknowledgeUnknownNetProfit === true;
    if (rewardPct !== PILOT.rewardPct || maxReward !== PILOT.maxRewardBRL || campaignLimit !== PILOT.budgetBRL || periodLimit !== PILOT.budgetBRL) {
        throw Object.assign(new Error("La configuración aprobada del piloto es fija: 1 %, máximo R$50 por referido y presupuesto total R$500."), { status: 400, code: "PILOT_CONFIG_FIXED" });
    }
    if (enabled && !unknownNetProfitAcknowledged) {
        throw Object.assign(new Error("Los costos netos no están verificados. Para activar, reconoce expresamente que la rentabilidad neta seguirá siendo desconocida."), { status: 409, code: "UNKNOWN_NET_PROFIT_ACK_REQUIRED" });
    }
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        if (enabled) await client.query("SELECT pg_advisory_xact_lock(hashtext('referral-program-budget'))");
        const before = (await client.query("SELECT * FROM referral_program_config WHERE id = 1 FOR UPDATE")).rows[0];
        if (!before) throw Object.assign(new Error("Falta la configuración del piloto"), { status: 409 });
        if (enabled) {
            const committed = await client.query(`SELECT COALESCE(SUM(reserved_reward_brl),0)::numeric AS total
                FROM customer_referrals WHERE status NOT IN ('RECHAZADA','CANCELADA')`);
            if (Number(committed.rows[0]?.total || 0) > PILOT.budgetBRL) {
                throw Object.assign(new Error("Los compromisos históricos superan R$500; no se puede activar el piloto sin revisar esas obligaciones."), { status: 409, code: "EXISTING_COMMITMENTS_OVER_BUDGET" });
            }
        }
        const now = Date.now();
        const expired = Boolean(before.enabled_at && (!before.expires_at || new Date(before.expires_at).getTime() <= now));
        if (enabled && expired && input.renewPilot !== true) {
            throw Object.assign(new Error("El piloto venció. La renovación requiere una acción administrativa explícita."), { status: 409, code: "EXPLICIT_RENEWAL_REQUIRED" });
        }
        const starting = enabled && !before.enabled_at;
        const renewing = enabled && expired && input.renewPilot === true;
        const result = await client.query(`UPDATE referral_program_config SET enabled = $1, reward_pct = $2,
            max_reward_brl = $3, campaign_limit_brl = $4, period_limit_brl = $5,
            unknown_net_profit_acknowledged = $6,
            enabled_at = CASE WHEN $1 AND ($7 OR $8) THEN NOW() ELSE enabled_at END,
            expires_at = CASE WHEN $1 AND ($7 OR $8) THEN NOW() + INTERVAL '30 days' ELSE expires_at END,
            updated_at = NOW(), updated_by = $9 WHERE id = 1 RETURNING *`,
        [enabled, rewardPct, maxReward, campaignLimit, periodLimit, unknownNetProfitAcknowledged, starting, renewing, actor || "admin"]);
        const after = result.rows[0];
        await client.query(`INSERT INTO referral_program_config_events (actor, action, before_config, after_config, details)
            VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)`, [actor || "admin", enabled ? (renewing ? "PILOTO_RENOVADO" : starting ? "PILOTO_ACTIVADO" : "CONFIGURACION_GUARDADA") : "PILOTO_DESACTIVADO",
            JSON.stringify(before), JSON.stringify(after), JSON.stringify({ renewPilot: renewing })]);
        await client.query("COMMIT");
        return after;
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
    } finally { client.release(); }
}

async function recordReferralLink({ referredPhone, code, evidence = "WHATSAPP_CODE", evidenceNote = null, actor = null, customerWasNew = false, termsCommunicated = evidence === "WHATSAPP_CODE" }, db = pool) {
    const referralCode = normalizeCode(code);
    if (!referredPhone || !REFERRAL_CODE_RE.test(referralCode)) return { linked: false, reason: "INVALID_CODE_FORMAT" };
    if (!["WHATSAPP_CODE", "ADMIN_VERIFIED"].includes(evidence)) return { linked: false, reason: "INVALID_EVIDENCE" };
    evidenceNote = String(evidenceNote || "").trim().slice(0, 500) || null;
    if (evidence === "ADMIN_VERIFIED" && !evidenceNote) return { linked: false, reason: "EVIDENCE_REQUIRED" };
    if (evidence === "ADMIN_VERIFIED" && termsCommunicated !== true) return { linked: false, reason: "TERMS_NOT_COMMUNICATED" };
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const locks = [`referral-code:${referralCode}`, `referral-person:${referredPhone}`].sort();
        for (const lock of locks) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
        await client.query("SELECT pg_advisory_xact_lock(hashtext('referral-program-budget'))");
        const config = await client.query("SELECT * FROM referral_program_config WHERE id = 1 FOR SHARE");
        const cfg = config.rows[0];
        if (!programAcceptingReferrals(cfg)) {
            await client.query("ROLLBACK");
            return { linked: false, reason: cfg?.enabled ? "PROGRAM_EXPIRED" : "PROGRAM_INACTIVE" };
        }
        if (evidence === "WHATSAPP_CODE" && !customerWasNew) {
            await client.query("ROLLBACK");
            return { linked: false, reason: "EXISTING_CUSTOMER" };
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
        const active = await client.query("SELECT id FROM operations WHERE phone = $1 AND status IN ('pendiente','confirmada') LIMIT 1", [referredPhone]);
        if (active.rows.length) {
            await client.query("ROLLBACK");
            return { linked: false, reason: "ACTIVE_OPERATION" };
        }
        const existing = await client.query("SELECT id, referrer_phone FROM customer_referrals WHERE referred_phone = $1 FOR UPDATE", [referredPhone]);
        if (existing.rows[0]) {
            await client.query("ROLLBACK");
            return { linked: false, reason: "ALREADY_LINKED", referralId: existing.rows[0].id };
        }
        const budget = await client.query(`SELECT COALESCE(SUM(reserved_reward_brl),0)::numeric AS committed
            FROM customer_referrals WHERE status NOT IN ('RECHAZADA','CANCELADA')`);
        const committed = Number(budget.rows[0]?.committed || 0);
        const budgetCap = Math.min(PILOT.budgetBRL, Number(cfg.campaign_limit_brl || PILOT.budgetBRL), Number(cfg.period_limit_brl || PILOT.budgetBRL));
        if (committed + PILOT.maxRewardBRL > budgetCap) {
            await client.query("ROLLBACK");
            return { linked: false, reason: "BUDGET_EXHAUSTED" };
        }
        const inserted = await client.query(`
            INSERT INTO customer_referrals
                (referral_code, referrer_phone, referred_phone, evidence, evidence_note, reward_pct,
                 reserved_reward_brl, participation_expires_at, status_reason)
            VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() + ($8 * INTERVAL '1 day'),
                'Reserva hasta R$50; primera remesa válida debe completarse dentro de 30 días del registro')
            RETURNING *
        `, [referralCode, referrer.rows[0].phone, referredPhone, evidence, String(evidenceNote || "").trim() || null,
            PILOT.rewardPct, PILOT.maxRewardBRL, PILOT.participationDays]);
        const row = inserted.rows[0];
        await client.query(`INSERT INTO customer_referral_events (referral_id, actor, action, to_status, details)
            VALUES ($1,$2,'VINCULACION_CREADA',$3,$4::jsonb)`,
        [row.id, actor || (evidence === "WHATSAPP_CODE" ? "whatsapp" : "admin"), row.status, JSON.stringify({ evidence, evidenceNote: row.evidence_note,
            participationExpiresAt: row.participation_expires_at, rewardPct: PILOT.rewardPct, reservedRewardBRL: PILOT.maxRewardBRL,
            termsCommunicated: true })]);
        await client.query(`INSERT INTO customer_referral_events (referral_id, actor, action, from_status, to_status, details)
            VALUES ($1,$2,'RESERVA_CREADA',NULL,$3,$4::jsonb)`,
        [row.id, actor || "system", row.status, JSON.stringify({ amountBRL: PILOT.maxRewardBRL, reason: "Compromiso máximo reservado antes de prometer beneficio" })]);
        await client.query("COMMIT");
        return { linked: true, referralId: row.id, status: row.status, reservedRewardBRL: Number(row.reserved_reward_brl || PILOT.maxRewardBRL), participationExpiresAt: row.participation_expires_at };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        if (error.code === "23505") return { linked: false, reason: "ALREADY_LINKED_OR_DUPLICATE" };
        throw error;
    } finally { client.release(); }
}

async function processReferralCodeMessage(phone, text, db = pool) {
    const raw = String(text || "").trim();
    const askCode = /^(?:mi|meu)\s+(?:c[oó]digo|codigo)\s+(?:de\s+)?(?:referidos?|indica[cç][aã]o)\s*\??$/i.test(raw);
    const match = raw.match(/\b(?:me\s+recomend[oó]|vengo\s+(?:recomendad[oa]\s+)?por|indica[cç][aã]o|referid[oa]\s+por|registrarme\s+con\s+c[oó]digo\s+de\s+referido|c[oó]digo\s+(?:de\s+)?referid[oa])\s*[:#-]?\s*([A-Z0-9]{10})\b/i);
    if (!askCode && !match) return { handled: false };
    const priorCustomer = await db.query("SELECT phone FROM customers WHERE phone = $1", [phone]);
    const customerWasNew = !priorCustomer.rows.length;
    if (customerWasNew && match) await db.query(`INSERT INTO customers (phone, created_at, updated_at) VALUES ($1,NOW(),NOW())
        ON CONFLICT (phone) DO NOTHING`, [phone]);
    if (askCode) {
        const config = await getProgramConfig(db);
        if (!programAcceptingReferrals(config)) return { handled: true, message: "El programa de referidos no está activo ahora. No compartas códigos por el momento." };
        const code = await ensureReferralCode(phone, db);
        const shareLink = code ? referralShareLink(code, await getOfficialWhatsAppNumber()) : null;
        if (code) await recordLinkGenerated(phone, Boolean(shareLink), db);
        return { handled: true, message: code
            ? `Tu enlace personal para compartir es: ${shareLink || `código ${code} (enlace no disponible ahora)`}. Si un cliente nuevo registra tu código y completa su primera remesa válida dentro de los 30 días siguientes, puedes recibir el 1 % (máximo R$50), sujeto a presupuesto disponible, validación y aprobación manual. No se paga automáticamente.`
            : "No encontré tu registro para generar el código. Escríbenos y lo revisamos." };
    }
    const result = await recordReferralLink({ referredPhone: phone, code: match[1], evidenceNote: "Código comunicado directamente por el cliente por WhatsApp", customerWasNew }, db);
    const messages = {
        PROGRAM_INACTIVE: "Gracias por contarnos. El programa de referidos todavía no está activo, así que no puedo registrar una recompensa ahora.",
        PROGRAM_EXPIRED: "El período del programa de referidos terminó y no admite nuevas participaciones.",
        UNKNOWN_CODE: "No pude validar ese código. Comprueba los 10 caracteres o pide a quien te recomendó que confirme su código.",
        SELF_REFERRAL: "El código no se puede utilizar para recomendarte a ti mismo.",
        ALREADY_LINKED: "Ya existe una referencia registrada para este número. No se puede cambiar automáticamente.",
        ALREADY_LINKED_OR_DUPLICATE: "La referencia ya estaba registrada o existe un registro duplicado; no se cambió el referente.",
        EXISTING_CUSTOMER: "Ese código solo puede vincularse durante el primer contacto con YORDA y antes de una remesa. Continúo ayudándote con tu solicitud.",
        BUDGET_EXHAUSTED: "El presupuesto disponible para nuevas referencias ya está comprometido. No registré una recompensa.",
        ACTIVE_OPERATION: "Ya hay una operación en curso asociada a este número; no puedo vincular una recompensa a una remesa iniciada antes del registro.",
        TERMS_NOT_COMMUNICATED: "Antes de registrar manualmente, informa al cliente que tiene 30 días desde la vinculación para completar su primera remesa.",
        ALREADY_COMPLETED_REMITTANCE: "No puedo vincular un referido después de que ya se completó una remesa; no hacemos asociaciones retroactivas."
    };
    const continueText = raw.replace(match[0], "").replace(/^[\s,;:.!?-]+/, "")
        .replace(/([,;:])(?:\s*[,;:])+/g, "$1").trim();
    return { handled: true, linked: result.linked, continueText, message: result.linked
        ? "Código registrado. Para que la referencia sea válida, completa tu primera remesa dentro de los 30 días siguientes. Tu referente podrá recibir el 1 % (máximo R$50), sujeto a presupuesto disponible, validación y aprobación manual."
        : (messages[result.reason] || "No pude registrar la referencia. Escríbenos para que el equipo la revise.") };
}

function normalizeReferralIntent(text) {
    return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[¿?¡!.,;:]+/g, " ").replace(/\s+/g, " ").trim();
}

function referralConversationIntent(text) {
    const value = normalizeReferralIntent(text);
    const financial = /(?:\br\$\s*\d|\busd\s*\d|\b\d+[,.]?\d*\s*(?:reais|brl|cup|mlc)\b|\b(cotiz|cotacao|enviar|envio|transfer|pix|comprovante|pagar|pago|operacion|entrega|tasa|cambio)\w*\b)/i.test(value);
    const yes = /^(si|si quiero|claro|por favor|dale|ok|okay|sim|quero|pode ser|manda|pasamelo|pasame el enlace|enviamelo)$/i.test(value);
    const no = /^(no|no gracias|ahora no|despues|nao|nao obrigado|agora nao)$/i.test(value);
    const asks = /\b(referid[oa]s?|recomend\w*|indic\w*|invit\w*)\b/.test(value)
        && /\b(como|quiero|quisiera|tienen|hay|puedo|compart|ganar|funciona|enlace|link|codigo|programa)\b/.test(value);
    const wantsLink = /\b(quiero|quisiera|puedo|como|compart|pasame|dame|obtener|generar|me das|manda|enviame)\b/.test(value)
        && /\b(enlace|link|codigo|referid[oa]s?|compart|invitar|amigo|amiga|recomendar)\b/.test(value);
    return { yes, no, asks, wantsLink, financial };
}

function isReferralLinkRequest(text) {
    const raw = String(text || "").trim();
    const asksForOwnCode = /^(?:mi|meu)\s+(?:c[oó]digo|codigo)\s+(?:de\s+)?(?:referidos?|indica[cç][aã]o)\s*\??$/i.test(raw);
    const intent = referralConversationIntent(raw);
    return asksForOwnCode || (!intent.financial && intent.wantsLink);
}

async function recordReferralConversationEvent(phone, action, messageId, details = {}, db = pool) {
    await db.query(`INSERT INTO referral_program_events (customer_phone, action, details)
        VALUES ($1,$2,$3::jsonb)`, [phone, action, JSON.stringify({
        channel: "WHATSAPP_INBOUND", evidenceMessageId: String(messageId || "").slice(0, 200) || null,
        interactionScope: "REFERRAL_PROGRAM_CONVERSATION", ...details
    })]);
}

/** Handles only a clear, customer-initiated referral conversation. A one-off
 * request for a link is not marketing consent and does not enter the campaign queue. */
async function processReferralConversation(phone, text, messageId, db = pool, deps = {}) {
    const intent = referralConversationIntent(text);
    if (intent.financial) return { handled: false };
    let latestOfferAction = null;
    if (intent.yes || intent.no || intent.asks) {
        const latest = await db.query(`SELECT action FROM referral_program_events
            WHERE customer_phone = $1 AND action IN ('ENLACE_OFRECIDO','ENLACE_ACEPTADO','ENLACE_RECHAZADO')
              AND occurred_at > NOW() - INTERVAL '30 minutes'
            ORDER BY occurred_at DESC, id DESC LIMIT 1`, [phone]);
        latestOfferAction = latest.rows[0]?.action || null;
    }
    const pendingOffer = latestOfferAction === "ENLACE_OFRECIDO";
    if (!intent.asks && !intent.wantsLink && !(pendingOffer && (intent.yes || intent.no))) return { handled: false };

    if (intent.asks && !intent.wantsLink && pendingOffer) {
        return { handled: true, message: "Ya te expliqué las condiciones 😊 Si quieres tu enlace personal, responde «sí» y te lo paso." };
    }

    const config = await getProgramConfig(db);
    const active = programAcceptingReferrals(config);
    if (intent.yes && pendingOffer && active) {
        await recordReferralConversationEvent(phone, "ENLACE_ACEPTADO", messageId,
            { consentRecorded: true, consentDecision: "YES", consentScope: "REFERRAL_LINK_ONLY" }, db);
        const code = await ensureReferralCode(phone, db);
        const link = code ? referralShareLink(code, await (deps.getOfficialWhatsAppNumber || getOfficialWhatsAppNumber)()) : null;
        if (code) await recordLinkGenerated(phone, Boolean(link), db);
        await recordReferralConversationEvent(phone, "ENLACE_SOLICITADO", messageId, { linkAvailable: Boolean(link) }, db);
        return { handled: true, message: link
            ? `Este es tu enlace personal: ${link}\n\nLa recompensa es del 1 % de la primera remesa válida de cada amigo, hasta R$50; sujeta a vigencia, presupuesto, validación y aprobación manual.`
            : "Puedo generar tu código, pero el enlace oficial no está disponible ahora. Escríbenos y te ayudamos." };
    }
    if (intent.no && pendingOffer) {
        await recordReferralConversationEvent(phone, "ENLACE_RECHAZADO", messageId,
            { consentRecorded: true, consentDecision: "NO", consentScope: "REFERRAL_LINK_ONLY" }, db);
        return { handled: true, message: "Entendido 😊 No te enviaré el enlace. Si lo necesitas más adelante, puedes preguntarme." };
    }
    if (!active) {
        await recordReferralConversationEvent(phone, "CONSULTA_REFERIDOS", messageId, { programActive: false }, db);
        return { handled: true, message: "Gracias por preguntar 😊 El programa de referidos no está activo ahora, así que no puedo prometer recompensas ni generar invitaciones. Si se habilita, podrás consultarme por aquí." };
    }
    if (intent.wantsLink) {
        const code = await ensureReferralCode(phone, db);
        const link = code ? referralShareLink(code, await (deps.getOfficialWhatsAppNumber || getOfficialWhatsAppNumber)()) : null;
        if (code) await recordLinkGenerated(phone, Boolean(link), db);
        await recordReferralConversationEvent(phone, "ENLACE_SOLICITADO", messageId, { linkAvailable: Boolean(link) }, db);
        return { handled: true, message: link
            ? `Este es tu enlace personal: ${link}\n\nTu amigo debe iniciar el registro con este enlace antes de su primera remesa. La recompensa es del 1 % de su primera remesa válida, hasta R$50, sujeta a vigencia, presupuesto, validación y aprobación manual.`
            : "No pude generar el enlace ahora. Escríbenos y lo revisamos." };
    }
    await recordReferralConversationEvent(phone, "CONSULTA_REFERIDOS", messageId, { eligibleReferrer: true }, db);
    return { handled: true, pendingLinkOffer: true, message: "🎁 El piloto ofrece el 1 % de la primera remesa válida de cada amigo que invites, hasta R$50; sujeto a vigencia, presupuesto disponible, validación y aprobación manual. ¿Quieres que te pase tu enlace personal?" };
}

async function onOperationCompleted(operation, db = pool) {
    if (!operation || !VALID_REMITTANCE_TYPES.includes(operation.tipo) || !(Number(operation.monto) > 0)) return { processed: false, reason: "NOT_ELIGIBLE_REMITTANCE" };
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`referral-person:${operation.phone}`]);
        await client.query("SELECT pg_advisory_xact_lock(hashtext('referral-program-budget'))");
        const first = await client.query(`SELECT id, monto, tipo, completed_at, created_at FROM operations
            WHERE phone = $1 AND status = 'completada' AND tipo = ANY($2::text[]) AND monto > 0 AND COALESCE(es_prueba,FALSE) = FALSE
            ORDER BY created_at ASC, id ASC LIMIT 1`, [operation.phone, VALID_REMITTANCE_TYPES]);
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
        if (new Date(first.rows[0].created_at).getTime() < new Date(row.linked_at).getTime()) {
            await client.query(`UPDATE customer_referrals SET status = 'CANCELADA', reserved_reward_brl = 0,
                status_reason = 'La operación se inició antes de vincular el código; no se atribuye retroactivamente', updated_at = NOW()
                WHERE id = $1`, [row.id]);
            await client.query(`INSERT INTO customer_referral_events (referral_id, actor, action, from_status, to_status, details)
                VALUES ($1,'system','VINCULACION_POSTERIOR_A_OPERACION',$2,'CANCELADA',$3::jsonb)`,
            [row.id, row.status, JSON.stringify({ operationId: first.rows[0].id, operationCreatedAt: first.rows[0].created_at, linkedAt: row.linked_at })]);
            await client.query(`INSERT INTO customer_referral_events (referral_id, actor, action, from_status, to_status, details)
                VALUES ($1,'system','RESERVA_LIBERADA',$2,'CANCELADA',$3::jsonb)`,
            [row.id, row.status, JSON.stringify({ amountBRL: Number(row.reserved_reward_brl || 0), reason: "La operación se inició antes de registrar la referencia" })]);
            await client.query("COMMIT");
            return { processed: false, reason: "OPERATION_PRECEDES_REFERRAL" };
        }
        const completedAt = first.rows[0].completed_at ? new Date(first.rows[0].completed_at) : null;
        const participationExpiresAt = row.participation_expires_at ? new Date(row.participation_expires_at) : null;
        if (participationExpiresAt && completedAt && completedAt.getTime() > participationExpiresAt.getTime()) {
            await client.query(`UPDATE customer_referrals SET status = 'CANCELADA', reserved_reward_brl = 0,
                expired_at = NOW(), status_reason = 'La primera remesa no se completó dentro de los 30 días comunicados', updated_at = NOW()
                WHERE id = $1`, [row.id]);
            await client.query(`INSERT INTO customer_referral_events (referral_id, actor, action, from_status, to_status, details)
                VALUES ($1,'system','PARTICIPACION_VENCIDA',$2,'CANCELADA',$3::jsonb)`,
            [row.id, row.status, JSON.stringify({ operationId: first.rows[0].id, completedAt: completedAt?.toISOString() || null,
                participationExpiresAt: participationExpiresAt.toISOString() })]);
            await client.query(`INSERT INTO customer_referral_events (referral_id, actor, action, from_status, to_status, details)
                VALUES ($1,'system','RESERVA_LIBERADA_VENCIMIENTO',$2,'CANCELADA',$3::jsonb)`,
            [row.id, row.status, JSON.stringify({ amountBRL: Number(row.reserved_reward_brl || 0), reason: "Primera remesa ausente o posterior al vencimiento de participación" })]);
            await client.query("COMMIT");
            return { processed: false, reason: "PARTICIPATION_EXPIRED" };
        }
        const config = await client.query("SELECT * FROM referral_program_config WHERE id = 1 FOR SHARE");
        const cfg = config.rows[0] || {};
        const amount = money(first.rows[0].monto);
        const reward = money(Math.min(amount * Number(row.reward_pct) / 100, PILOT.maxRewardBRL, Number(cfg.max_reward_brl || PILOT.maxRewardBRL)));
        let costReviewReason = !completedAt ? "La fecha de finalización de la remesa no está disponible; requiere revisión humana" : null;
        if (completedAt) {
            try {
                const benefits = await client.query(`SELECT COALESCE(c.nivel_vip,0)::int AS nivel_vip,
                    (o.activa AND COALESCE(o.texto,'') <> '' AND (o.vence_at IS NULL OR o.vence_at > NOW())) AS oferta_general_activa,
                    (o.activa_vip AND COALESCE(o.texto_vip,'') <> '' AND COALESCE(c.nivel_vip,0) > 0) AS oferta_vip_activa
                    FROM customers c LEFT JOIN ofertas o ON o.id = 1 WHERE c.phone = $1`, [operation.phone]);
                const benefit = benefits.rows[0];
                if (!benefit) costReviewReason = "No se pudieron verificar los beneficios existentes del referido";
                else if (Number(benefit.nivel_vip) > 0 || benefit.oferta_general_activa || benefit.oferta_vip_activa) {
                    costReviewReason = "Puede acumular beneficios VIP u oferta vigente cuyo costo no está cuantificado; revisar margen antes de aprobar";
                }
            } catch (_) {
                costReviewReason = "No se pudieron verificar costos promocionales/VIP acumulados; requiere revisión humana";
            }
        }
        let reviewReason = costReviewReason;
        let reservationAfter = Number(row.reserved_reward_brl || 0);
        if ([cfg.max_reward_brl, cfg.campaign_limit_brl, cfg.period_limit_brl].some(value => value == null)) reviewReason ||= "Faltan límites económicos configurados; requiere revisión humana";
        else if (!(amount > 0) || !(reward > 0)) reviewReason ||= "Importe o recompensa no válidos";
        else if (reward > Number(cfg.max_reward_brl)) reviewReason ||= "Supera el límite configurado por recompensa";
        else {
            const usage = await client.query(`SELECT COALESCE(SUM(reserved_reward_brl),0) AS total FROM customer_referrals
                WHERE status NOT IN ('RECHAZADA','CANCELADA') AND id <> $1`, [row.id]);
            const campaignTotal = Number(usage.rows[0]?.total || 0) + reward;
            const cap = Math.min(PILOT.budgetBRL, Number(cfg.campaign_limit_brl), Number(cfg.period_limit_brl));
            if (campaignTotal > cap) reviewReason ||= "Supera el límite acumulado configurado para el programa";
            else reservationAfter = reward;
        }
        const nextStatus = reviewReason ? "REVISION" : "ELEGIBLE";
        await client.query(`UPDATE customer_referrals SET first_operation_id = $2, first_amount_brl = $3,
            reward_brl = $4, reserved_reward_brl = $5,
            status = $6, eligible_at = CASE WHEN $6 = 'ELEGIBLE' THEN NOW() ELSE eligible_at END,
            status_reason = $7, updated_at = NOW() WHERE id = $1`,
        [row.id, first.rows[0].id, amount, reward, reservationAfter, nextStatus, reviewReason || "Primera remesa completada; requiere revisión humana"]);
        await client.query(`INSERT INTO customer_referral_events (referral_id, actor, action, from_status, to_status, details)
            VALUES ($1,'system','PRIMERA_REMESA_VALIDADA',$2,$3,$4::jsonb)`,
        [row.id, row.status, nextStatus, JSON.stringify({ operationId: first.rows[0].id, amountBRL: amount, rewardBRL: reward, reason: reviewReason })]);
        if (Number(row.reserved_reward_brl || 0) !== reservationAfter) {
            await client.query(`INSERT INTO customer_referral_events (referral_id, actor, action, from_status, to_status, details)
                VALUES ($1,'system','RESERVA_AJUSTADA',$2,$3,$4::jsonb)`,
            [row.id, row.status, nextStatus, JSON.stringify({ beforeBRL: Number(row.reserved_reward_brl || 0), afterBRL: reservationAfter, reason: "Reserva máxima ajustada a recompensa calculada" })]);
        }
        await client.query("COMMIT");
        return { processed: true, referralId: Number(row.id), status: nextStatus, amountBRL: amount, rewardBRL: reward, reason: reviewReason };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
    } finally { client.release(); }
}

async function reconcilePendingReferralAccruals(db = pool, limit = 100) {
    const expired = await expirePendingReferralReservations(db, limit);
    const pending = await db.query(`SELECT r.referred_phone AS phone, o.id, o.monto, o.tipo
        FROM customer_referrals r JOIN LATERAL (
            SELECT op.id, op.monto, op.tipo, op.completed_at FROM operations op
            WHERE op.phone = r.referred_phone AND op.status = 'completada'
              AND op.tipo = ANY($1::text[]) AND op.monto > 0
              AND COALESCE(op.es_prueba,FALSE) = FALSE AND op.completed_at >= r.linked_at
              AND (r.participation_expires_at IS NULL OR op.completed_at <= r.participation_expires_at)
            ORDER BY op.completed_at ASC NULLS LAST, op.id ASC LIMIT 1
        ) o ON TRUE
        WHERE r.status = 'PENDIENTE' ORDER BY o.id LIMIT $2`,
    [VALID_REMITTANCE_TYPES, Math.min(500, Math.max(1, Number(limit) || 100))]);
    let processed = 0;
    for (const operation of pending.rows) {
        const result = await onOperationCompleted(operation, db);
        if (result.processed) processed++;
    }
    return { inspected: pending.rows.length, processed, expired };
}

async function expirePendingReferralReservations(db = pool, limit = 100) {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('referral-program-budget'))");
        const due = await client.query(`SELECT id, reserved_reward_brl FROM customer_referrals
            WHERE status = 'PENDIENTE' AND participation_expires_at IS NOT NULL
              AND participation_expires_at <= NOW()
              AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.phone = customer_referrals.referred_phone
                  AND o.status = 'completada' AND o.tipo = ANY($2::text[]) AND o.monto > 0
                  AND COALESCE(o.es_prueba,FALSE) = FALSE AND o.completed_at >= customer_referrals.linked_at
                  AND o.completed_at <= customer_referrals.participation_expires_at)
            ORDER BY participation_expires_at, id
            LIMIT $1 FOR UPDATE SKIP LOCKED`, [Math.min(500, Math.max(1, Number(limit) || 100)), VALID_REMITTANCE_TYPES]);
        for (const row of due.rows) {
            const releasedBRL = Number(row.reserved_reward_brl || 0);
            await client.query(`UPDATE customer_referrals SET status = 'CANCELADA', reserved_reward_brl = 0,
                expired_at = NOW(), status_reason = 'Participación vencida sin primera remesa completada dentro de 30 días', updated_at = NOW()
                WHERE id = $1 AND status = 'PENDIENTE'`, [row.id]);
            await client.query(`INSERT INTO customer_referral_events
                (referral_id, actor, action, from_status, to_status, details)
                VALUES ($1,'system','PARTICIPACION_VENCIDA','PENDIENTE','CANCELADA',$2::jsonb)`,
            [row.id, JSON.stringify({ releasedReservationBRL: releasedBRL })]);
            await client.query(`INSERT INTO customer_referral_events
                (referral_id, actor, action, from_status, to_status, details)
                VALUES ($1,'system','RESERVA_LIBERADA_VENCIMIENTO','PENDIENTE','CANCELADA',$2::jsonb)`,
            [row.id, JSON.stringify({ amountBRL: releasedBRL, reason: "Venció el plazo comunicado sin transferencia válida" })]);
        }
        await client.query("COMMIT");
        return due.rows.length;
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        throw error;
    } finally { client.release(); }
}

async function reviewReversedOperation(operationId, db = pool) {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('referral-program-budget'))");
        const before = await client.query("SELECT * FROM customer_referrals WHERE first_operation_id = $1 FOR UPDATE", [operationId]);
        const row = before.rows[0];
        if (!row || !["ELEGIBLE", "APROBADA", "LIQUIDADA"].includes(row.status)) {
            await client.query("COMMIT");
            return null;
        }
        const next = row.status === "LIQUIDADA" ? "REVISION_REVERSO" : "CANCELADA";
        const updated = await client.query(`UPDATE customer_referrals SET status = $2,
            reserved_reward_brl = CASE WHEN $2 = 'CANCELADA' THEN 0 ELSE reserved_reward_brl END,
            status_reason = 'La primera operación vinculada fue revertida; revisar recompensa manualmente',
            reversed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`, [row.id, next]);
        await client.query(`INSERT INTO customer_referral_events (referral_id, actor, action, from_status, to_status, details)
            VALUES ($1,'system','OPERACION_REVERTIDA',$2,$3,$4::jsonb)`,
        [row.id, row.status, next, JSON.stringify({ operationId })]);
        if (next === "CANCELADA" && Number(row.reserved_reward_brl || 0) > 0) {
            await client.query(`INSERT INTO customer_referral_events (referral_id, actor, action, from_status, to_status, details)
                VALUES ($1,'system','RESERVA_LIBERADA',$2,$3,$4::jsonb)`,
            [row.id, row.status, next, JSON.stringify({ amountBRL: Number(row.reserved_reward_brl), reason: "Operación vinculada revertida antes de liquidación" })]);
        }
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
        await client.query("SELECT pg_advisory_xact_lock(hashtext('referral-program-budget'))");
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
            if (Number(row.reward_brl) > PILOT.maxRewardBRL || (cfg.max_reward_brl != null && Number(row.reward_brl) > Number(cfg.max_reward_brl))) throw Object.assign(new Error("La recompensa todavía excede el máximo configurado"), { status: 409 });
            const campaign = await client.query(`SELECT COALESCE(SUM(reserved_reward_brl),0) AS total FROM customer_referrals
                WHERE status NOT IN ('RECHAZADA','CANCELADA') AND id <> $1`, [id]);
            const reservation = Number(row.reserved_reward_brl || row.reward_brl || 0);
            const cap = Math.min(PILOT.budgetBRL, Number(cfg.campaign_limit_brl), Number(cfg.period_limit_brl));
            if (Number(campaign.rows[0]?.total || 0) + reservation > cap) throw Object.assign(new Error("El presupuesto comprometido del piloto sigue excedido"), { status: 409 });
        }
        const updated = await client.query(`UPDATE customer_referrals SET status = $2, status_reason = $3,
            reserved_reward_brl = CASE WHEN $2 IN ('RECHAZADA','CANCELADA') THEN 0 WHEN $2 = 'ELEGIBLE' THEN reward_brl ELSE reserved_reward_brl END,
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
        if (["RECHAZADA", "CANCELADA"].includes(transition.to) && Number(row.reserved_reward_brl || 0) > 0) {
            await client.query(`INSERT INTO customer_referral_events
                (referral_id, actor, action, from_status, to_status, details)
                VALUES ($1,$2,'RESERVA_LIBERADA',$3,$4,$5::jsonb)`,
            [id, actor, from, transition.to, JSON.stringify({ amountBRL: Number(row.reserved_reward_brl), reason: transition.to === "RECHAZADA" ? "Recompensa rechazada por operador" : "Participación cancelada por operador" })]);
        }
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
        COUNT(*) FILTER (WHERE first_operation_id IS NOT NULL)::int AS primeras_remesas_completadas,
        COUNT(*) FILTER (WHERE status = 'PENDIENTE')::int AS esperando_primera_remesa,
        COUNT(*) FILTER (WHERE status = 'ELEGIBLE')::int AS elegibles,
        COUNT(*) FILTER (WHERE status = 'APROBADA')::int AS aprobadas,
        COUNT(*) FILTER (WHERE status = 'LIQUIDADA')::int AS liquidadas,
        COUNT(*) FILTER (WHERE status IN ('REVISION','REVISION_REVERSO'))::int AS en_revision,
        COUNT(*) FILTER (WHERE expired_at IS NOT NULL)::int AS participaciones_vencidas,
        COALESCE(SUM(reserved_reward_brl) FILTER (WHERE status NOT IN ('RECHAZADA','CANCELADA')),0)::numeric AS costo_comprometido_brl,
        COALESCE(SUM(first_amount_brl) FILTER (WHERE first_operation_id IS NOT NULL),0)::numeric AS volumen_primeras_remesas_brl,
        COALESCE(SUM(reward_brl) FILTER (WHERE first_operation_id IS NOT NULL),0)::numeric AS recompensas_acumuladas_brl,
        COALESCE(SUM(reward_brl) FILTER (WHERE status = 'LIQUIDADA'),0)::numeric AS recompensas_liquidadas_brl,
        COALESCE(SUM(reserved_reward_brl) FILTER (WHERE status = 'APROBADA'),0)::numeric AS recompensas_aprobadas_brl,
        COUNT(*) FILTER (WHERE first_operation_id IS NOT NULL)::int AS conversiones_con_primera_remesa
        FROM customer_referrals`);
    return result.rows[0] || {};
}

function calculateReferralScenarios({ rewardPct = PILOT.rewardPct, maxRewardBRL = PILOT.maxRewardBRL } = {}) {
    return [500, 1000, 3000, 5000].map(amountBRL => {
        const rewardBRL = money(Math.min(amountBRL * rewardPct / 100, maxRewardBRL));
        const grossMarginReferenceBRL = money(amountBRL * 0.05);
        return { amountBRL, rewardBRL, grossMarginReferenceBRL,
            grossReferenceAfterRewardBRL: money(grossMarginReferenceBRL - rewardBRL),
            netProfitBRL: null, netProfitKnown: false,
            note: "Referencia bruta al 5 % menos recompensa; no es beneficio neto e ignora costos no cuantificados." };
    });
}

async function getReferralInviteCandidates(db = pool, limit = 20) {
    const result = await db.query(`
        SELECT c.phone, c.nombre, COALESCE(c.nivel_vip,0)::int AS nivel_vip,
               COUNT(o.id)::int AS remittances_365d,
               COALESCE(SUM(o.monto),0)::numeric AS volume_365d_brl,
               MAX(o.completed_at) AS last_completed_at
        FROM customers c
        JOIN operations o ON o.phone = c.phone
        WHERE o.status = 'completada' AND o.tipo = ANY($1::text[])
          AND o.monto > 0 AND COALESCE(o.es_prueba,FALSE) = FALSE
          AND o.completed_at >= NOW() - INTERVAL '365 days'
          AND NOT COALESCE(c.marketing_opt_out,FALSE)
          AND c.marketing_consent_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM bot_inbound_messages bi WHERE bi.phone=c.phone AND bi.recibido_at > NOW() - INTERVAL '24 hours')
          AND (c.pausa_hasta IS NULL OR c.pausa_hasta <= NOW())
          AND NOT EXISTS (SELECT 1 FROM blocked_numbers b WHERE b.phone = c.phone)
          AND NOT EXISTS (SELECT 1 FROM operations active WHERE active.phone = c.phone AND active.status IN ('pendiente','confirmada'))
          AND NOT EXISTS (SELECT 1 FROM commercial_contact_events ce WHERE ce.phone = c.phone
              AND ce.occurred_at >= NOW() - INTERVAL '30 days'
              AND ce.provider_status IN ('SENDING','SENT','UNKNOWN'))
          AND NOT EXISTS (SELECT 1 FROM commercial_contact_events ce WHERE ce.phone = c.phone
              AND ce.response_status = 'DECLINED')
        GROUP BY c.phone, c.nombre, c.nivel_vip
        ORDER BY COUNT(o.id) DESC, MAX(o.completed_at) DESC, c.phone
        LIMIT $2`, [VALID_REMITTANCE_TYPES, Math.min(20, Math.max(1, Number(limit) || 20))]);
    return result.rows.map(row => ({ ...row,
        selectionEvidence: `${Number(row.remittances_365d)} remesa(s) válida(s) completada(s) en los últimos 365 días; última: ${row.last_completed_at || "sin fecha verificable"}.`,
        requiresComplaintCheck: true,
        limitation: "YORDA no tiene un registro estructurado de reclamaciones; verificar incidencias manualmente antes de cualquier invitación." }));
}

async function getReferralInviteConsentSummary(db = pool) {
    const result = await db.query(`WITH eligible AS (
        SELECT DISTINCT c.phone, c.marketing_consent_at,
          EXISTS (SELECT 1 FROM bot_inbound_messages bi WHERE bi.phone=c.phone AND bi.recibido_at > NOW() - INTERVAL '24 hours') AS window_open
        FROM customers c JOIN operations o ON o.phone = c.phone
        WHERE o.status = 'completada' AND o.tipo = ANY($1::text[])
          AND o.monto > 0 AND COALESCE(o.es_prueba,FALSE) = FALSE
          AND o.completed_at >= NOW() - INTERVAL '365 days'
          AND NOT COALESCE(c.marketing_opt_out,FALSE)
          AND (c.pausa_hasta IS NULL OR c.pausa_hasta <= NOW())
          AND NOT EXISTS (SELECT 1 FROM blocked_numbers b WHERE b.phone=c.phone)
          AND NOT EXISTS (SELECT 1 FROM operations active WHERE active.phone=c.phone AND active.status IN ('pendiente','confirmada'))
          AND NOT EXISTS (SELECT 1 FROM commercial_contact_events ce WHERE ce.phone=c.phone
              AND ce.occurred_at >= NOW() - INTERVAL '30 days' AND ce.provider_status IN ('SENDING','SENT','UNKNOWN'))
          AND NOT EXISTS (SELECT 1 FROM commercial_contact_events ce WHERE ce.phone=c.phone AND ce.response_status='DECLINED')
    ) SELECT COUNT(*) FILTER(WHERE marketing_consent_at IS NOT NULL AND window_open)::int AS with_consent_and_window,
             COUNT(*) FILTER(WHERE marketing_consent_at IS NOT NULL AND NOT window_open)::int AS with_consent_without_window,
             COUNT(*) FILTER(WHERE marketing_consent_at IS NULL)::int AS without_consent
      FROM eligible`, [VALID_REMITTANCE_TYPES]);
    return result.rows[0] || { with_consent_and_window: 0, with_consent_without_window: 0, without_consent: 0 };
}

function buildReferralLaunchCopy(config = {}) {
    const pct = Number(config.reward_pct || PILOT.rewardPct);
    const maxReward = Number(config.max_reward_brl || PILOT.maxRewardBRL);
    return [
        "🎁 Recomienda YORDA y gana",
        "",
        "Invita a un amigo que todavía no haya enviado dinero con nosotros.",
        `Cuando registre tu código y complete su primera remesa válida dentro de los 30 días siguientes, recibes el ${pct} % del valor enviado, hasta R$${maxReward}.`,
        "",
        "📲 Comparte tu enlace personal y comienza a recomendar.",
        "",
        "*Promoción sujeta a condiciones, vigencia y disponibilidad del presupuesto. El piloto admite nuevos registros durante 30 días desde su activación; cada participación conserva 30 días para completar la primera remesa. Recompensas sujetas a validación y aprobación manual.*"
    ].join("\n");
}

async function ensureReferralLaunchDraft(db = pool) {
    const library = require("./content-library");
    const asset = await library.createDirectorDraft({
        titulo: "Piloto de referidos · invitación comercial",
        cuerpo: buildReferralLaunchCopy(await getProgramConfig(db)),
        grupo: "permanente",
        categoria: "referidos",
        aporte: "Propuesta breve para captar nuevos clientes mediante recomendaciones verificadas, con términos explícitos, recompensa limitada y aprobación manual. Borrador no publicado ni enviado.",
        impacto: { estado: "NO_ENVIADO", conversionesEsperadas: null, beneficioNetoBRL: null },
        fuentes: [{ nombre: "Configuración administrativa del programa de referidos", titulo: "Condiciones del piloto configuradas en YORDA", url: "internal://referral-program-config" }],
        origenSistema: "referral-pilot-launch-v1"
    }, db);
    if (asset.estado !== "BORRADOR") {
        throw Object.assign(new Error("El contenido del programa ya no está en estado de borrador; requiere revisión del operador antes de reutilizarse."), { code: "REFERRAL_DRAFT_NOT_PENDING" });
    }
    return asset;
}

async function getAcquisitionOverview(db = pool) {
    const [config, referrals, secondTransferCandidates, inviteCandidates, inviteConsent] = await Promise.all([
        getProgramConfig(db), getReferralSummary(db), getSecondTransferSummary(db), getReferralInviteCandidates(db, 20), getReferralInviteConsentSummary(db)
    ]);
    const budget = Math.min(PILOT.budgetBRL, Number(config.campaign_limit_brl || PILOT.budgetBRL), Number(config.period_limit_brl || PILOT.budgetBRL));
    const committed = Number(referrals.costo_comprometido_brl || 0);
    const events = await db.query(`SELECT
            COUNT(*) FILTER (WHERE action = 'ENLACE_GENERADO' AND details->>'linkAvailable' = 'true')::int AS links_generated,
            COUNT(*) FILTER (WHERE action = 'ENLACE_SOLICITADO')::int AS links_requested,
            COUNT(*) FILTER (WHERE action = 'CONSULTA_REFERIDOS')::int AS referral_queries,
            COUNT(*) FILTER (WHERE action = 'ENLACE_OFRECIDO')::int AS link_offers_provider_accepted,
            COUNT(*) FILTER (WHERE action = 'ENLACE_OFRECIMIENTO_FALLIDO')::int AS link_offers_failed
        FROM referral_program_events`);
    const volume = Number(referrals.volumen_primeras_remesas_brl || 0);
    const invited = await db.query(`SELECT COUNT(DISTINCT phone)::int AS count FROM commercial_contact_events
        WHERE source = 'REFERRAL_PILOT' AND provider_status IN ('SENDING','SENT','UNKNOWN')`);
    const acquisitionCost = Number(referrals.conversiones_con_primera_remesa || 0) > 0
        ? money(Number(referrals.recompensas_acumuladas_brl || 0) / Number(referrals.conversiones_con_primera_remesa)) : null;
    const activeNow = programAcceptingReferrals(config);
    const programStatus = activeNow ? "ACTIVO" : config.enabled && config.expires_at && new Date(config.expires_at).getTime() <= Date.now() ? "EXPIRADO" : "DESACTIVADO";
    return { config: { ...config, program_status: programStatus }, referrals, secondTransferCandidates,
        secondTransferWindow: "Una remesa válida hace 7–45 días, exactamente una remesa completada, e interés posterior comprobable; sin operación activa, opt-out, pausa, bloqueo ni contacto comercial enviado en 14 días.",
        referralEconomics: { rewardPct: PILOT.rewardPct, maxRewardBRL: Math.min(PILOT.maxRewardBRL, Number(config.max_reward_brl || PILOT.maxRewardBRL)), campaignLimitBRL: budget, committedBRL: committed, availableBRL: Math.max(0, money(budget - committed)), periodLimitBRL: budget, durationDays: PILOT.durationDays, participationDays: PILOT.participationDays, scenarios: calculateReferralScenarios(), netProfitKnown: false, unknownNetProfitAcknowledged: Boolean(config.unknown_net_profit_acknowledged) },
        referralMetrics: { invited: Number(invited.rows[0]?.count || 0), inviteCandidates: inviteCandidates.length, eligibleWithConsentAndWindow: Number(inviteConsent.with_consent_and_window || 0), excludedWithoutConsent: Number(inviteConsent.without_consent || 0), consentedWithoutOpenWindow: Number(inviteConsent.with_consent_without_window || 0), linksGenerated: Number(events.rows[0]?.links_generated || 0), linksRequested: Number(events.rows[0]?.links_requested || 0), referralQueries: Number(events.rows[0]?.referral_queries || 0), linkOffersAcceptedByProvider: Number(events.rows[0]?.link_offers_provider_accepted || 0), linkOffersFailed: Number(events.rows[0]?.link_offers_failed || 0), registeredReferrals: Number(referrals.vinculados || 0), convertedReferrals: Number(referrals.primeras_remesas_completadas || 0), firstRemittanceVolumeBRL: volume, committedRewardBRL: committed, approvedRewardBRL: Number(referrals.recompensas_aprobadas_brl || 0), paidRewardBRL: Number(referrals.recompensas_liquidadas_brl || 0), expiredParticipations: Number(referrals.participaciones_vencidas || 0), acquisitionCostPerConvertedClientBRL: acquisitionCost, grossMarginReferenceBRL: money(volume * 0.05), otherCostsKnown: false, netProfitBRL: null, aiCostBRL: null },
        launchProposal: { status: "BORRADOR_NO_ENVIADO", audience: "Hasta 20 clientes con remesas legítimas, consentimiento comercial explícito verificable y ventana de conversación abierta; sin operación activa, bloqueo, opt-out, pausa humana, contacto comercial reciente o rechazo registrado. Revisión manual de reclamaciones pendiente porque no hay registro estructurado.", audienceCount: inviteCandidates.length, eligibleWithConsentCount: Number(inviteConsent.with_consent_and_window || 0), excludedWithoutConsentCount: Number(inviteConsent.without_consent || 0), consentedWithoutOpenWindowCount: Number(inviteConsent.with_consent_without_window || 0), channels: ["WhatsApp individual mediante enlace personal"], terms: `${Number(config.duration_days || PILOT.durationDays)} días desde activación explícita para nuevos registros; cada referido dispone de ${PILOT.participationDays} días desde su vinculación para completar la primera remesa; recompensa ${Number(config.reward_pct || PILOT.rewardPct)} % con máximo R$ ${Number(config.max_reward_brl || PILOT.maxRewardBRL).toFixed(2)} por referido; presupuesto total R$ ${budget.toFixed(2)}.`, draft: buildReferralLaunchCopy(config), successCriteria: ["Referidos nuevos con primera remesa válida", "Volumen BRL confirmado", "Compromisos dentro del presupuesto", "Costo de adquisición por conversión liquidada"], followUp: "Revisión semanal por el operador; no se envían recordatorios automáticos.", candidates: inviteCandidates, candidateLimitations: ["Los clientes sin consentimiento comercial verificable se excluyen de la lista de invitación proactiva.", "Aunque tengan consentimiento, los clientes sin ventana abierta se excluyen hasta integrar plantillas aprobadas.", "No existe un registro estructurado de reclamaciones; confirmar manualmente que cada candidato no tenga una incidencia abierta antes de cualquier invitación.", "La atribución solo cuenta códigos validados y primeras remesas completadas; ningún mensaje está autorizado por esta propuesta."] }
    };
}

module.exports = {
    REFERRAL_CODE_RE, VALID_REMITTANCE_TYPES, PILOT, normalizeCode, randomCode, referralShareLink, getOfficialWhatsAppNumber, recordLinkGenerated,
    ensureReferralCode, getProgramConfig, saveProgramConfig, recordReferralLink,
    processReferralCodeMessage, processReferralConversation, referralConversationIntent, isReferralLinkRequest, recordReferralConversationEvent,
    onOperationCompleted, reviewReversedOperation,
    reconcilePendingReferralAccruals, expirePendingReferralReservations,
    transitionReferral, listReferrals, getReferralSummary,
    getSecondTransferCandidates, getSecondTransferSummary, getAcquisitionOverview, getReferralInviteCandidates, getReferralInviteConsentSummary,
    calculateReferralScenarios, buildReferralLaunchCopy, ensureReferralLaunchDraft, followupMessage
};
