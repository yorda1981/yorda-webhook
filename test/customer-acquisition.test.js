"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const acquisition = require("../src/services/customer-acquisition");

function makeEligibilityDb(amount = 500, { operationCreatedAt = new Date(), completedAt = new Date(), linkedAt = new Date(Date.now() - 60000), expiresAt = new Date(Date.now() + 86400000), vipLevel = 0, activeOffer = false } = {}) {
    const state = { referral: { id: 7, status: "PENDIENTE", reward_pct: "1.00", reserved_reward_brl: "50", linked_at: linkedAt, participation_expires_at: expiresAt }, updates: 0, events: 0 };
    const client = {
        async query(sql, params = []) {
            const q = String(sql).replace(/\s+/g, " ").trim();
            if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK" || q.includes("pg_advisory_xact_lock")) return { rows: [] };
            if (q.includes("SELECT id, monto, tipo, completed_at, created_at FROM operations")) return { rows: [{ id: 25, monto: String(amount), tipo: "brl_cup", completed_at: completedAt, created_at: operationCreatedAt }] };
            if (q.includes("SELECT * FROM customer_referrals WHERE referred_phone")) return { rows: [{ ...state.referral }] };
            if (q.includes("SELECT * FROM referral_program_config")) return { rows: [{ enabled: true, reward_pct: "1.00", max_reward_brl: "50", campaign_limit_brl: "500", period_limit_brl: "500", enabled_at: new Date("2026-01-01"), expires_at: new Date(Date.now() + 86400000) }] };
            if (q.includes("SELECT COALESCE(SUM(reserved_reward_brl),0) AS total FROM customer_referrals")) return { rows: [{ total: "0" }] };
            if (q.includes("SELECT COALESCE(c.nivel_vip,0)::int AS nivel_vip")) return { rows: [{ nivel_vip: vipLevel, oferta_general_activa: activeOffer, oferta_vip_activa: false }] };
            if (q.includes("UPDATE customer_referrals SET first_operation_id")) {
                state.updates++;
                state.referral = { ...state.referral, first_operation_id: params[1], first_amount_brl: params[2], reward_brl: params[3], reserved_reward_brl: params[4], status: params[5] };
                return { rows: [] };
            }
            if (q.includes("UPDATE customer_referrals SET status = 'CANCELADA'")) { state.referral.status = "CANCELADA"; state.referral.reserved_reward_brl = 0; state.referral.expired_at = new Date(); return { rows: [] }; }
            if (q.includes("INSERT INTO customer_referral_events")) { state.events++; return { rows: [] }; }
            throw new Error(`Unexpected SQL: ${q}`);
        },
        release() {}
    };
    return { state, connect: async () => client };
}

function makeTransitionDb(initialStatus = "APROBADA") {
    const state = { referral: { id: 4, status: initialStatus }, events: 0 };
    const client = {
        async query(sql, params = []) {
            const q = String(sql).replace(/\s+/g, " ").trim();
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q) || q.includes("pg_advisory_xact_lock")) return { rows: [] };
            if (q.includes("SELECT * FROM customer_referrals WHERE id")) return { rows: [{ ...state.referral }] };
            if (q.includes("UPDATE customer_referrals SET status =")) {
                state.referral.status = params[1];
                return { rows: [{ ...state.referral }] };
            }
            if (q.includes("INSERT INTO customer_referral_events")) { state.events++; return { rows: [] }; }
            throw new Error(`Unexpected SQL: ${q}`);
        },
        release() {}
    };
    return { state, connect: async () => client };
}

function makeLinkDb({ self = false, expired = false, inactive = false, activeOperation = false, budget = 0 } = {}) {
    const state = { linked: new Map(), audit: 0, committed: budget, locks: new Map(), nextId: 1 };
    return {
        state,
        async connect() {
            const held = [];
            return {
                async query(sql, params = []) {
                    const q = String(sql).replace(/\s+/g, " ").trim();
                    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q)) {
                        if (q === "COMMIT" || q === "ROLLBACK") held.splice(0).reverse().forEach(release => release());
                        return { rows: [] };
                    }
                    if (q.includes("pg_advisory_xact_lock")) {
                        const key = String(params[0]);
                        const previous = state.locks.get(key) || Promise.resolve();
                        let unlock;
                        state.locks.set(key, new Promise(resolve => { unlock = resolve; }));
                        await previous;
                        held.push(unlock);
                        return { rows: [] };
                    }
                    if (q.includes("SELECT * FROM referral_program_config")) return { rows: [{ enabled: !inactive, reward_pct: "1", max_reward_brl: "50", campaign_limit_brl: "500", period_limit_brl: "500", enabled_at: new Date(), expires_at: new Date(Date.now() + (expired ? -86400000 : 86400000)) }] };
                    if (q.includes("SELECT phone FROM customers WHERE phone =")) return { rows: [{ phone: params[0] }] };
                    if (q.includes("SELECT phone FROM customers WHERE referral_code")) return { rows: [{ phone: self ? "5511999999999" : "5511888888888" }] };
                    if (q.includes("SELECT id FROM operations") && q.includes("status = 'completada'")) return { rows: [] };
                    if (q.includes("SELECT id FROM operations") && q.includes("status IN ('pendiente','confirmada')")) return { rows: activeOperation ? [{ id: 3 }] : [] };
                    if (q.includes("SELECT id, referrer_phone FROM customer_referrals")) return { rows: state.linked.has(params[0]) ? [state.linked.get(params[0])] : [] };
                    if (q.includes("SELECT COALESCE(SUM(reserved_reward_brl),0)::numeric AS committed")) return { rows: [{ committed: String(state.committed) }] };
                    if (q.includes("INSERT INTO customer_referrals")) {
                        const id = state.nextId++;
                        const row = { id, referrer_phone: params[1], participation_expires_at: new Date(Date.now() + Number(params[7]) * 86400000) };
                        state.linked.set(params[2], row); state.committed += Number(params[6]);
                        return { rows: [{ ...row, status: "PENDIENTE", evidence_note: params[4], reserved_reward_brl: params[6] }] };
                    }
                    if (q.includes("INSERT INTO customer_referral_events")) { state.audit++; return { rows: [] }; }
                    throw new Error(`Unexpected SQL: ${q}`);
                },
                release() { held.splice(0).reverse().forEach(release => release()); }
            };
        }
    };
}

test("código aleatorio cumple formato de 50 bits; códigos inválidos no se aceptan", () => {
    const code = acquisition.randomCode();
    assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
    assert.equal(acquisition.normalizeCode(" ab-cd "), "ABCD");
    assert.equal(acquisition.REFERRAL_CODE_RE.test("ABCDEFGH"), false);
});

test("solo un mensaje explícito con código dispara registro; no usa IA para atribuir", async () => {
    const db = { query: async () => { throw new Error("no debe consultar DB"); } };
    assert.deepEqual(await acquisition.processReferralCodeMessage("5511999999999", "Hola, me recomendaron YORDA", db), { handled: false });
});

test("reconoce preguntas naturales de referidos sin capturar confirmaciones financieras ambiguas", () => {
    for (const phrase of ["¿Cómo puedo ganar recomendando?", "¿Tienen programa de referidos?", "Quiero invitar a un amigo", "¿Cómo comparto mi enlace?", "Quiero mi enlace de referido"]) {
        const intent = acquisition.referralConversationIntent(phrase);
        assert.equal(intent.asks || intent.wantsLink, true, phrase);
    }
    assert.equal(acquisition.isReferralLinkRequest("Quiero mi enlace de referido"), true);
    assert.equal(acquisition.isReferralLinkRequest("mi código de referido"), true);
    assert.equal(acquisition.isReferralLinkRequest("Quiero cotizar R$500"), false);
    assert.equal(acquisition.referralConversationIntent("Sí, quiero cotizar R$500").yes, false);
    assert.equal(acquisition.referralConversationIntent("Quiero invitar a un amigo y cotizar R$500").financial, true);
    assert.equal(acquisition.referralConversationIntent("Sí").yes, true);
});

test("pregunta natural informa que el programa apagado no ofrece recompensa y deja evidencia", async () => {
    const calls = [];
    const db = { async query(sql, params = []) {
        calls.push({ sql: String(sql), params });
        if (String(sql).includes("SELECT * FROM referral_program_config")) return { rows: [{ enabled: false }] };
        return { rows: [] };
    } };
    const result = await acquisition.processReferralConversation("5511999999999", "¿Tienen programa de referidos?", "wa-q-1", db);
    assert.equal(result.handled, true);
    assert.match(result.message, /no está activo ahora/i);
    assert.doesNotMatch(result.message, /puedes ganar el 1 %/i);
    const evidence = calls.find(call => call.sql.includes("INSERT INTO referral_program_events"));
    assert.ok(evidence);
    assert.match(evidence.params[1], /CONSULTA_REFERIDOS/);
    assert.match(evidence.params[2], /WHATSAPP_INBOUND/);
    assert.match(evidence.params[2], /wa-q-1/);
});

test("solicitud explícita de enlace con piloto desactivado no genera código ni promete recompensa", async () => {
    const db = { async query(sql) {
        if (String(sql).includes("SELECT * FROM referral_program_config")) return { rows: [{ enabled: false }] };
        if (String(sql).includes("SELECT action FROM referral_program_events")) return { rows: [] };
        if (String(sql).includes("INSERT INTO referral_program_events")) return { rows: [] };
        throw new Error(`Unexpected SQL: ${sql}`);
    } };
    const result = await acquisition.processReferralConversation("5511999999999", "Quiero mi enlace de referido", "wa-off-1", db);
    assert.equal(result.handled, true);
    assert.match(result.message, /no está activo/i);
    assert.doesNotMatch(result.message, /wa\.me|puedes recibir|gana el/i);
});

test("cualquier cliente registrado, aunque no haya remitido, recibe su enlace al pedirlo", async () => {
    const calls = [];
    const db = { async query(sql, params = []) {
        const q = String(sql).replace(/\\s+/g, " ").trim();
        calls.push({ q, params });
        if (q.includes("SELECT action FROM referral_program_events")) return { rows: [] };
        if (q.includes("SELECT * FROM referral_program_config")) return { rows: [{ enabled: true, reward_pct: "1", max_reward_brl: "50", campaign_limit_brl: "500", period_limit_brl: "500", expires_at: new Date(Date.now() + 86400000) }] };
        if (q.includes("UPDATE customers SET referral_code")) return { rows: [{ referral_code: "AB23456789" }] };
        if (q.includes("INSERT INTO referral_program_events")) return { rows: [] };
        throw new Error(`Unexpected SQL: ${q}`);
    } };
    const result = await acquisition.processReferralConversation("5511999999999", "Quiero invitar a un amigo", "wa-link-1", db,
        { getOfficialWhatsAppNumber: async () => "+55 (11) 98888-7777" });
    assert.equal(result.handled, true);
    assert.match(result.message, /https:\/\/wa\.me\/5511988887777\?text=/);
    assert.match(result.message, /hasta R\$50/);
    assert.match(result.message, /aprobación manual/);
    assert.ok(calls.some(call => call.q.includes("UPDATE customers SET referral_code")));
    assert.ok(calls.some(call => call.q.includes("INSERT INTO referral_program_events") && call.params[1] === "ENLACE_SOLICITADO"));
    assert.equal(calls.some(call => call.q.includes("FROM operations")), false);
});

test("generar el código no reserva presupuesto y las solicitudes repetidas conservan el mismo código", async () => {
    const saved = new Map();
    let generated = 0;
    const db = { async query(sql, params = []) {
        const q = String(sql).replace(/\s+/g, " ").trim();
        if (q.includes("SELECT * FROM referral_program_config")) return { rows: [{ enabled: true, expires_at: new Date(Date.now() + 86400000) }] };
        if (q.includes("UPDATE customers SET referral_code")) {
            const code = saved.get(params[0]) || params[1];
            saved.set(params[0], code);
            return { rows: [{ referral_code: code }] };
        }
        throw new Error(`Unexpected SQL: ${q}`);
    } };
    const generate = () => (++generated === 1 ? "AB23456789" : "CD34567890");
    assert.equal(await acquisition.ensureReferralCode("5511999999999", db, generate), "AB23456789");
    assert.equal(await acquisition.ensureReferralCode("5511999999999", db, generate), "AB23456789");
    assert.equal(generated, 2);
});

test("el mismo enlace permite vincular dos clientes nuevos distintos concurrentemente con reservas separadas", async () => {
    const db = makeLinkDb();
    const [first, second] = await Promise.all([
        acquisition.recordReferralLink({ referredPhone: "5511999999001", code: "AB23456789", customerWasNew: true }, db),
        acquisition.recordReferralLink({ referredPhone: "5511999999002", code: "AB23456789", customerWasNew: true }, db)
    ]);
    assert.equal(first.linked, true);
    assert.equal(second.linked, true);
    assert.equal(db.state.linked.size, 2);
    assert.equal(db.state.committed, 100);
});

test("aceptar una oferta reciente entrega el enlace y registra consentimiento limitado al enlace", async () => {
    const calls = [];
    const db = { async query(sql, params = []) {
        const q = String(sql).replace(/\\s+/g, " ").trim();
        calls.push({ q, params });
        if (q.includes("SELECT action FROM referral_program_events")) return { rows: [{ action: "ENLACE_OFRECIDO" }] };
        if (q.includes("SELECT * FROM referral_program_config")) return { rows: [{ enabled: true, reward_pct: "1", max_reward_brl: "50", campaign_limit_brl: "500", period_limit_brl: "500", expires_at: new Date(Date.now() + 86400000) }] };
        if (q.includes("SELECT 1 FROM operations")) return { rows: [{ ok: 1 }] };
        if (q.includes("SELECT COALESCE(SUM(reserved_reward_brl),0)::numeric AS total")) return { rows: [{ total: "0" }] };
        if (q.includes("UPDATE customers SET referral_code")) return { rows: [{ referral_code: "CD34567890" }] };
        if (q.includes("INSERT INTO referral_program_events")) return { rows: [] };
        throw new Error(`Unexpected SQL: ${q}`);
    } };
    const result = await acquisition.processReferralConversation("5511999999999", "Sí", "wa-yes-2", db,
        { getOfficialWhatsAppNumber: async () => "5511988887777" });
    assert.match(result.message, /https:\/\/wa\.me\/5511988887777/);
    const accepted = calls.find(call => call.params[1] === "ENLACE_ACEPTADO");
    assert.ok(accepted);
    assert.match(accepted.params[2], /REFERRAL_LINK_ONLY/);
    assert.match(accepted.params[2], /\"consentDecision\":\"YES\"/);
});

test("un cliente que ya existía no se registra como referido nuevo y conserva el resto de su solicitud", async () => {
    const linkDb = makeLinkDb();
    const db = { query: async sql => String(sql).includes("SELECT phone FROM customers") ? { rows: [{ phone: "5511999999999" }] } : { rows: [] }, connect: linkDb.connect };
    const result = await acquisition.processReferralCodeMessage("5511999999999", "código de referido AB23456789, quiero cotizar R$500", db);
    assert.equal(result.linked, false);
    assert.equal(result.continueText, "quiero cotizar R$500");
    assert.match(result.message, /primer contacto/);
});

test("vincula código válido antes de la primera remesa y evita self-referral, asociación retroactiva y códigos inválidos", async () => {
    const db = makeLinkDb();
    const linked = await acquisition.recordReferralLink({ referredPhone: "5511999999999", code: "AB23456789", evidenceNote: "Código declarado", customerWasNew: true }, db);
    assert.equal(linked.linked, true);
    assert.equal(linked.reservedRewardBRL, 50);
    assert.ok(linked.participationExpiresAt);
    assert.equal(db.state.audit, 2);
    const duplicate = await acquisition.recordReferralLink({ referredPhone: "5511999999999", code: "AB23456789", evidenceNote: "Otra evidencia", customerWasNew: true }, db);
    assert.equal(duplicate.reason, "ALREADY_LINKED");
    assert.equal((await acquisition.recordReferralLink({ referredPhone: "5511999999999", code: "AB23456789", customerWasNew: true }, makeLinkDb({ self: true }))).reason, "SELF_REFERRAL");
    const invalidDb = { connect: async () => { throw new Error("No debe acceder a DB"); } };
    assert.equal((await acquisition.recordReferralLink({ referredPhone: "x", code: "BAD" }, invalidDb)).reason, "INVALID_CODE_FORMAT");
});

test("dos registros concurrentes para el mismo referido dejan una sola vinculación auditada", async () => {
    const db = makeLinkDb();
    const input = { referredPhone: "5511999999999", code: "AB23456789", evidenceNote: "Declaración en WhatsApp", customerWasNew: true };
    const outcomes = await Promise.all([acquisition.recordReferralLink(input, db), acquisition.recordReferralLink(input, db)]);
    assert.equal(outcomes.filter(item => item.linked).length, 1);
    assert.equal(db.state.audit, 2);
});

test("la vinculación manual exige que el plazo de 30 días se haya comunicado", async () => {
    const db = { connect: async () => { throw new Error("No debe reservar presupuesto sin confirmar el plazo"); } };
    const result = await acquisition.recordReferralLink({ referredPhone: "5511999999999", code: "AB23456789",
        evidence: "ADMIN_VERIFIED", evidenceNote: "El cliente fue referido" }, db);
    assert.equal(result.reason, "TERMS_NOT_COMMUNICATED");
});

test("una primera transferencia BRL completada calcula 1 % una vez y la segunda no genera otra recompensa", async () => {
    const db = makeEligibilityDb();
    const operation = { id: 25, phone: "5511999999999", monto: 500, tipo: "brl_cup" };
    const first = await acquisition.onOperationCompleted(operation, db);
    assert.equal(first.status, "ELEGIBLE");
    assert.equal(first.rewardBRL, 5);
    const second = await acquisition.onOperationCompleted(operation, db);
    assert.equal(second.reason, "ELEGIBLE");
    assert.equal(db.state.updates, 1);
    assert.equal(db.state.events, 2);
});

test("una primera remesa completada después del cierre del piloto se conserva si cae dentro de los 30 días de participación", async () => {
    const db = makeEligibilityDb(500, { expiresAt: new Date(Date.now() + 3 * 86400000) });
    const original = db.connect;
    db.connect = async () => {
        const client = await original();
        const query = client.query.bind(client);
        client.query = async (sql, params = []) => {
            if (String(sql).includes("SELECT * FROM referral_program_config")) return { rows: [{ enabled: false, max_reward_brl: "50", campaign_limit_brl: "500", period_limit_brl: "500", expires_at: new Date(Date.now() - 86400000) }] };
            return query(sql, params);
        };
        return client;
    };
    const result = await acquisition.onOperationCompleted({ id: 25, phone: "5511999999999", monto: 500, tipo: "brl_cup" }, db);
    assert.equal(result.status, "ELEGIBLE");
    assert.equal(result.rewardBRL, 5);
});

test("una transferencia posterior al vencimiento de su participación libera la reserva y no genera recompensa", async () => {
    const db = makeEligibilityDb(500, { completedAt: new Date(Date.now() + 2 * 86400000), expiresAt: new Date(Date.now() + 86400000) });
    const result = await acquisition.onOperationCompleted({ id: 25, phone: "5511999999999", monto: 500, tipo: "brl_cup" }, db);
    assert.equal(result.reason, "PARTICIPATION_EXPIRED");
    assert.equal(db.state.referral.status, "CANCELADA");
    assert.equal(db.state.referral.reserved_reward_brl, 0);
    assert.ok(db.state.referral.expired_at);
});

test("un beneficio VIP u oferta activa requiere revisión económica antes de aprobar", async () => {
    const vip = await acquisition.onOperationCompleted({ id: 25, phone: "5511999999999", monto: 500, tipo: "brl_cup" }, makeEligibilityDb(500, { vipLevel: 2 }));
    assert.equal(vip.status, "REVISION");
    assert.match(vip.reason, /VIP u oferta vigente/);
    const offer = await acquisition.onOperationCompleted({ id: 25, phone: "5511999999999", monto: 500, tipo: "brl_cup" }, makeEligibilityDb(500, { activeOffer: true }));
    assert.equal(offer.status, "REVISION");
});

test("el tope individual es R$50 y cubre las cuatro escalas económicas del piloto", async () => {
    const result = await acquisition.onOperationCompleted({ id: 25, phone: "5511999999999", monto: 3000, tipo: "brl_cup" }, makeEligibilityDb(3000));
    assert.equal(result.rewardBRL, 30);
    assert.equal(acquisition.onOperationCompleted ? acquisition.PILOT.maxRewardBRL : 0, 50);
    assert.deepEqual(acquisition.calculateReferralScenarios().map(row => [row.amountBRL, row.rewardBRL, row.grossMarginReferenceBRL, row.grossReferenceAfterRewardBRL]), [
        [500, 5, 25, 20], [1000, 10, 50, 40], [3000, 30, 150, 120], [5000, 50, 250, 200]
    ]);
    assert.ok(acquisition.calculateReferralScenarios().every(row => row.netProfitBRL === null && row.netProfitKnown === false));
    assert.equal((await acquisition.onOperationCompleted({ id: 25, phone: "5511999999999", monto: 5000, tipo: "brl_cup" }, makeEligibilityDb(5000))).rewardBRL, 50);
});

test("no atribuye ni reserva recompensa por una operación iniciada antes del registro", async () => {
    const beforeReferral = new Date("2026-10-01T12:00:00Z");
    const linkedAfter = new Date("2026-10-01T12:01:00Z");
    const db = makeEligibilityDb(500, { operationCreatedAt: beforeReferral, linkedAt: linkedAfter });
    const result = await acquisition.onOperationCompleted({ id: 25, phone: "5511999999999", monto: 500, tipo: "brl_cup" }, db);
    assert.equal(result.reason, "OPERATION_PRECEDES_REFERRAL");
    assert.equal(db.state.referral.status, "CANCELADA");
    assert.equal(db.state.referral.reserved_reward_brl, 0);
});

test("operaciones de prueba, canceladas u otros servicios nunca generan recompensa", async () => {
    const db = { connect: async () => { throw new Error("No debe tocar DB"); } };
    assert.deepEqual(await acquisition.onOperationCompleted({ id: 1, phone: "x", tipo: "recarga_nacional", monto: 100 }, db), { processed: false, reason: "NOT_ELIGIBLE_REMITTANCE" });
    const source = fs.readFileSync(path.join(__dirname, "../src/services/customer-acquisition.js"), "utf8");
    assert.match(source, /COALESCE\(es_prueba,FALSE\) = FALSE/);
    const migration = fs.readFileSync(path.join(__dirname, "../migrations/0037_referrals_and_second_remittance.sql"), "utf8");
    assert.match(migration, /es_prueba BOOLEAN NOT NULL DEFAULT FALSE/);
});

test("no se puede activar el programa sin topes económicos ni reconocer margen neto desconocido", async () => {
    await assert.rejects(() => acquisition.saveProgramConfig({ enabled: true, rewardPct: 1, maxRewardBRL: 20, campaignLimitBRL: 200, periodLimitBRL: 200, acknowledgeUnknownNetProfit: true }, "admin"), /configuración aprobada del piloto es fija/);
    await assert.rejects(() => acquisition.saveProgramConfig({ enabled: true, rewardPct: 1, maxRewardBRL: 50, campaignLimitBRL: 500, periodLimitBRL: 500 }, "admin"), /rentabilidad neta seguirá siendo desconocida/);
});

test("enlace wa.me codifica mensaje y no contiene teléfono administrativo ni datos internos", () => {
    const link = acquisition.referralShareLink("AB23456789", "+55 (11) 98888-7777");
    assert.equal(link, "https://wa.me/5511988887777?text=Hola%2C%20quiero%20registrarme%20con%20c%C3%B3digo%20de%20referido%20AB23456789");
    assert.equal(acquisition.referralShareLink("AB23456789", null), null);
});

test("la lista piloto de referidos solo admite clientes con consentimiento y separa elegibles sin consentimiento", async () => {
    let candidateSql = "";
    const db = { query: async sql => {
        const q = String(sql).replace(/\s+/g, " ");
        if (q.includes("FROM customers c") && q.includes("GROUP BY c.phone")) {
            candidateSql = q;
            return { rows: [{ phone: "5511888887777", nombre: "Test", nivel_vip: 1, remittances_365d: 2, last_completed_at: new Date() }] };
        }
        return { rows: [{ with_consent_and_window: 1, with_consent_without_window: 2, without_consent: 4 }] };
    } };
    const candidates = await acquisition.getReferralInviteCandidates(db, 20);
    const summary = await acquisition.getReferralInviteConsentSummary(db);
    assert.equal(candidates.length, 1);
    assert.match(candidateSql, /c\.marketing_consent_at IS NOT NULL/);
    assert.deepEqual(summary, { with_consent_and_window: 1, with_consent_without_window: 2, without_consent: 4 });
});

test("reserva el máximo de R$50 de forma serializada; con R$500 solo admite diez referidos", async () => {
    const db = makeLinkDb();
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, index) => acquisition.recordReferralLink({
        referredPhone: `55119999999${String(index).padStart(2, "0")}`, code: "AB23456789", evidenceNote: "Código enviado", customerWasNew: true
    }, db)));
    assert.equal(outcomes.filter(item => item.linked).length, 10);
    assert.equal(outcomes.filter(item => item.reason === "BUDGET_EXHAUSTED").length, 2);
    assert.equal(db.state.committed, 500);
});

test("la configuración administrativa guarda R$50/R$500 con el programa desactivado", async () => {
    const state = { events: 0, update: null };
    const db = { async connect() { return { async query(sql, params = []) {
        const q = String(sql).replace(/\s+/g, " ").trim();
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q)) return { rows: [] };
        if (q.includes("SELECT * FROM referral_program_config WHERE id = 1 FOR UPDATE")) return { rows: [{ enabled: false, reward_pct: "1", max_reward_brl: "20", campaign_limit_brl: "200", period_limit_brl: "200", enabled_at: null, expires_at: null }] };
        if (q.includes("UPDATE referral_program_config SET enabled")) { state.update = params; return { rows: [{ enabled: false, reward_pct: "1", max_reward_brl: "50", campaign_limit_brl: "500", period_limit_brl: "500", duration_days: 30, enabled_at: null, expires_at: null }] }; }
        if (q.includes("INSERT INTO referral_program_config_events")) { state.events++; return { rows: [] }; }
        throw new Error(`Unexpected SQL: ${q}`);
    }, release() {} }; } };
    const saved = await acquisition.saveProgramConfig({ enabled: false, rewardPct: 1, maxRewardBRL: 50, campaignLimitBRL: 500, periodLimitBRL: 500 }, "admin", db);
    assert.equal(saved.enabled, false);
    assert.deepEqual(state.update.slice(0, 6), [false, 1, 50, 500, 500, false]);
    assert.equal(state.events, 1);
});

test("la limpieza vence solo participaciones pendientes de 30 días y audita la liberación", async () => {
    const calls = [];
    const db = { async connect() { return { async query(sql, params = []) {
        const q = String(sql).replace(/\s+/g, " ").trim(); calls.push({ q, params });
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q) || q.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (q.includes("SELECT id, reserved_reward_brl FROM customer_referrals")) return { rows: [{ id: 9, reserved_reward_brl: "50" }] };
        if (q.includes("UPDATE customer_referrals SET status = 'CANCELADA'")) return { rows: [] };
        if (q.includes("INSERT INTO customer_referral_events")) return { rows: [] };
        throw new Error(`Unexpected SQL: ${q}`);
    }, release() {} }; } };
    const expired = await acquisition.expirePendingReferralReservations(db);
    assert.equal(expired, 1);
    assert.match(calls.find(c => c.q.includes("SELECT id, reserved_reward_brl")).q, /status = 'PENDIENTE'/);
    assert.match(calls.at(-3).q, /PARTICIPACION_VENCIDA/);
    assert.match(calls.at(-2).q, /RESERVA_LIBERADA_VENCIMIENTO/);
    assert.equal(JSON.parse(calls.at(-2).params[1]).amountBRL, 50);
});

test("la limpieza conserva una participación vencida en calendario si existe una primera remesa completada dentro del plazo", async () => {
    let expiryQuery = "";
    const db = { async connect() { return { async query(sql) {
        const q = String(sql).replace(/\s+/g, " ").trim();
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q) || q.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (q.includes("SELECT id, reserved_reward_brl FROM customer_referrals")) { expiryQuery = q; return { rows: [] }; }
        throw new Error(`Unexpected SQL: ${q}`);
    }, release() {} }; } };
    assert.equal(await acquisition.expirePendingReferralReservations(db), 0);
    assert.match(expiryQuery, /NOT EXISTS/);
    assert.match(expiryQuery, /o\.completed_at <= customer_referrals\.participation_expires_at/);
});

test("piloto vencido o inactivo no acepta nuevas participaciones", async () => {
    const data = { referredPhone: "5511999999999", code: "AB23456789", customerWasNew: true };
    assert.equal((await acquisition.recordReferralLink(data, makeLinkDb({ expired: true }))).reason, "PROGRAM_EXPIRED");
    assert.equal((await acquisition.recordReferralLink(data, makeLinkDb({ inactive: true }))).reason, "PROGRAM_INACTIVE");
});

test("no vincula referidos cuando el cliente ya tiene una operación en curso", async () => {
    const result = await acquisition.recordReferralLink({ referredPhone: "5511999999999", code: "AB23456789", customerWasNew: true }, makeLinkDb({ activeOperation: true }));
    assert.equal(result.reason, "ACTIVE_OPERATION");
});

test("liquidación requiere estado aprobado, método y referencia y es idempotente", async () => {
    const db = makeTransitionDb("APROBADA");
    await assert.rejects(() => acquisition.transitionReferral(4, "settle", {}, db), /requiere método y referencia/);
    const result = await acquisition.transitionReferral(4, "settle", { method: "PIX manual", reference: "comprovante-123", actor: "admin" }, db);
    assert.equal(result.status, "LIQUIDADA");
    await assert.rejects(() => acquisition.transitionReferral(4, "settle", { method: "PIX manual", reference: "comprovante-123" }, db), /Transición no permitida/);
    assert.equal(db.state.events, 1);
});

test("recompensas elegibles no se pueden liquidar directamente sin aprobación", async () => {
    const db = makeTransitionDb("ELEGIBLE");
    await assert.rejects(() => acquisition.transitionReferral(4, "settle", { method: "PIX", reference: "ref" }, db), /Transición no permitida/);
});

test("segunda remesa exige ventana, una remesa, señal posterior y exclusiones; solo prepara texto", async () => {
    let query = "";
    const db = { query: async sql => { query = String(sql); return { rows: [{ phone: "5511999999999", nombre: "Ana", tipo_favorito: "brl_cup", first_completed_at: new Date(), has_quote_signal: true, has_inbound_signal: false }] }; } };
    const rows = await acquisition.getSecondTransferCandidates({}, db);
    assert.equal(rows.length, 1);
    assert.match(rows[0].preparedMessage, /primera remesa/i);
    assert.match(query, /INTERVAL '7 days'/);
    assert.match(query, /INTERVAL '45 days'/);
    assert.match(query, /marketing_opt_out/);
    assert.match(query, /blocked_numbers/);
    assert.match(query, /status IN \('pendiente','confirmada'\)/);
    assert.match(query, /INTERVAL '14 days'/);
    assert.match(query, /bot_inbound_messages/);
});

test("la propuesta comercial comunica ambos plazos, el máximo y queda sin probabilidades inventadas", () => {
    const draft = acquisition.buildReferralLaunchCopy({ reward_pct: "1", max_reward_brl: "50" });
    assert.match(draft, /🎁 Recomienda YORDA y gana/);
    assert.match(draft, /dentro de los 30 días siguientes/);
    assert.match(draft, /1 %.*hasta R\$50/);
    assert.match(draft, /disponibilidad del presupuesto/);
    assert.match(draft, /aprobación manual/);
});

test("la propuesta se integra en Biblioteca como borrador del Director y fuera de publicación automática", async () => {
    const state = { body: null, events: 0 };
    const now = new Date();
    const db = {
        async query(sql) {
            const q = String(sql);
            if (q.includes("SELECT * FROM referral_program_config")) return { rows: [{ enabled: false, reward_pct: "1", max_reward_brl: "50", campaign_limit_brl: "500", period_limit_brl: "500", duration_days: 30 }] };
            if (q.includes("FROM content_items ci") && q.includes("origen_sistema = $1")) return { rows: [] };
            throw new Error(`Unexpected SQL: ${q}`);
        },
        async connect() { return { async query(sql, params = []) {
            const q = String(sql);
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q.trim())) return { rows: [] };
            if (q.includes("INSERT INTO content_items")) return { rows: [{ id: "111", titulo: params[0], creado_at: now, actualizado_at: now, estado: "BORRADOR", origen: "director", grupo: params[1], categoria: params[2], aporte: params[3], impacto: JSON.parse(params[4]), fuentes: JSON.parse(params[5]) }] };
            if (q.includes("INSERT INTO content_revisions")) { state.body = params[1]; return { rows: [{ id: "112", numero: 1, cuerpo: params[1] }] }; }
            if (q.includes("INSERT INTO content_events")) { state.events++; return { rows: [] }; }
            throw new Error(`Unexpected SQL: ${q}`);
        }, release() {} }; }
    };
    const asset = await acquisition.ensureReferralLaunchDraft(db);
    assert.equal(asset.id, 111);
    assert.equal(asset.estado, "BORRADOR");
    assert.match(state.body, /hasta R\$50/);
    assert.equal(state.events, 1);
});

test("recorrido sintético: código recibido, continúa cotización, primera remesa, aprobación manual y sin segunda recompensa", async () => {
    const phone = "5511999999999";
    const linkDb = makeLinkDb();
    const botDb = {
        async query(sql) {
            if (String(sql).includes("SELECT phone FROM customers WHERE phone")) return { rows: [] };
            if (String(sql).includes("INSERT INTO customers")) return { rows: [] };
            throw new Error(`Unexpected bot SQL: ${sql}`);
        },
        connect: linkDb.connect
    };
    const bot = await acquisition.processReferralCodeMessage(phone, `Hola, código de referido AB23456789, quiero cotizar R$500`, botDb);
    assert.equal(bot.linked, true);
    assert.equal(bot.continueText, "Hola, quiero cotizar R$500");
    assert.match(bot.message, /30 días/);

    const operationDb = makeEligibilityDb(500);
    const first = await acquisition.onOperationCompleted({ id: 25, phone, monto: 500, tipo: "brl_cup" }, operationDb);
    assert.equal(first.rewardBRL, 5);
    assert.equal(first.status, "ELEGIBLE");
    const admin = makeTransitionDb("ELEGIBLE");
    const approved = await acquisition.transitionReferral(4, "approve", { actor: "operador" }, admin);
    assert.equal(approved.status, "APROBADA");
    const settled = await acquisition.transitionReferral(4, "settle", { actor: "operador", method: "PIX manual", reference: "proof-001" }, admin);
    assert.equal(settled.status, "LIQUIDADA");
    await assert.rejects(() => acquisition.transitionReferral(4, "settle", { method: "PIX manual", reference: "proof-001" }, admin), /Transición no permitida/);

    const second = await acquisition.onOperationCompleted({ id: 25, phone, monto: 500, tipo: "brl_cup" }, operationDb);
    assert.equal(second.reason, "ELEGIBLE");
    assert.equal(operationDb.state.updates, 1);
});

test("la selección de invitaciones limita a 20 y excluye opt-out, bloqueo, operación activa, pausa, rechazos y contacto reciente", async () => {
    let sql = ""; let params;
    const db = { async query(q, p) { sql = String(q); params = p; return { rows: [{ phone: "5511999999999", nombre: "Ana", nivel_vip: 0, remittances_365d: 3, volume_365d_brl: "800", last_completed_at: new Date() }] }; } };
    const candidates = await acquisition.getReferralInviteCandidates(db, 100);
    assert.equal(candidates.length, 1);
    assert.equal(params[1], 20);
    assert.match(sql, /marketing_opt_out/);
    assert.match(sql, /marketing_consent_at IS NOT NULL/);
    assert.match(sql, /bot_inbound_messages/);
    assert.match(sql, /blocked_numbers/);
    assert.match(sql, /status IN \('pendiente','confirmada'\)/);
    assert.match(sql, /pausa_hasta/);
    assert.match(sql, /INTERVAL '30 days'/);
    assert.match(sql, /response_status = 'DECLINED'/);
    assert.equal(candidates[0].requiresComplaintCheck, true);
});

test("la interfaz y rutas administrativas no contienen ejecución automática de campañas ni pagos", () => {
    const router = fs.readFileSync(path.join(__dirname, "../src/routes/content-library.js"), "utf8");
    const ui = fs.readFileSync(path.join(__dirname, "../public/content-center.html"), "utf8");
    assert.match(router, /acquisition\/referrals\/:id\/:action/);
    assert.match(ui, /Registrar liquidación manual/);
    assert.match(ui, /Borrador preparado, no enviado/);
    assert.match(ui, /Guardar borrador en Biblioteca/);
    assert.match(ui, /con consentimiento y ventana abierta/i);
    assert.match(ui, /hasta 20 clientes, sin contactar/);
    assert.doesNotMatch(router, /enviarMensaje|enviarSeguro|pagarRecompensa/);
    const migration = fs.readFileSync(path.join(__dirname, "../migrations/0040_referral_pilot_50_500_participation_expiry.sql"), "utf8");
    assert.match(migration, /participation_expires_at/);
    assert.doesNotMatch(migration, /UPDATE customer_referrals[\s\S]*participation_expires_at/);
});
