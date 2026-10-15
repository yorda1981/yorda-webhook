"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const acquisition = require("../src/services/customer-acquisition");

function makeEligibilityDb(amount = 500, { operationCreatedAt = new Date(), linkedAt = new Date(Date.now() - 60000) } = {}) {
    const state = { referral: { id: 7, status: "PENDIENTE", reward_pct: "1.00", reserved_reward_brl: "20", linked_at: linkedAt }, updates: 0, events: 0 };
    const client = {
        async query(sql, params = []) {
            const q = String(sql).replace(/\s+/g, " ").trim();
            if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK" || q.includes("pg_advisory_xact_lock")) return { rows: [] };
            if (q.includes("SELECT id, monto, tipo, completed_at, created_at FROM operations")) return { rows: [{ id: 25, monto: String(amount), tipo: "brl_cup", completed_at: new Date(), created_at: operationCreatedAt }] };
            if (q.includes("SELECT * FROM customer_referrals WHERE referred_phone")) return { rows: [{ ...state.referral }] };
            if (q.includes("SELECT * FROM referral_program_config")) return { rows: [{ enabled: true, reward_pct: "1.00", max_reward_brl: "20", campaign_limit_brl: "200", period_limit_brl: "200", enabled_at: new Date("2026-01-01"), expires_at: new Date(Date.now() + 86400000) }] };
            if (q.includes("SELECT COALESCE(SUM(reserved_reward_brl),0) AS total FROM customer_referrals")) return { rows: [{ total: "0" }] };
            if (q.includes("UPDATE customer_referrals SET first_operation_id")) {
                state.updates++;
                state.referral = { ...state.referral, first_operation_id: params[1], first_amount_brl: params[2], reward_brl: params[3], status: params[4] };
                return { rows: [] };
            }
            if (q.includes("UPDATE customer_referrals SET status = 'CANCELADA'")) { state.referral.status = "CANCELADA"; state.referral.reserved_reward_brl = 0; return { rows: [] }; }
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
                    if (q.includes("SELECT * FROM referral_program_config")) return { rows: [{ enabled: !inactive, reward_pct: "1", max_reward_brl: "20", campaign_limit_brl: "200", period_limit_brl: "200", enabled_at: new Date(), expires_at: new Date(Date.now() + (expired ? -86400000 : 86400000)) }] };
                    if (q.includes("SELECT phone FROM customers WHERE phone =")) return { rows: [{ phone: params[0] }] };
                    if (q.includes("SELECT phone FROM customers WHERE referral_code")) return { rows: [{ phone: self ? "5511999999999" : "5511888888888" }] };
                    if (q.includes("SELECT id FROM operations") && q.includes("status = 'completada'")) return { rows: [] };
                    if (q.includes("SELECT id FROM operations") && q.includes("status IN ('pendiente','confirmada')")) return { rows: activeOperation ? [{ id: 3 }] : [] };
                    if (q.includes("SELECT id, referrer_phone FROM customer_referrals")) return { rows: state.linked.has(params[0]) ? [state.linked.get(params[0])] : [] };
                    if (q.includes("SELECT COALESCE(SUM(reserved_reward_brl),0)::numeric AS committed")) return { rows: [{ committed: String(state.committed) }] };
                    if (q.includes("INSERT INTO customer_referrals")) {
                        const id = state.nextId++;
                        const row = { id, referrer_phone: params[1] };
                        state.linked.set(params[2], row); state.committed += Number(params[6]);
                        return { rows: [{ id, status: "PENDIENTE", evidence_note: params[4], reserved_reward_brl: params[6] }] };
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
    assert.equal(db.state.audit, 1);
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
    assert.equal(db.state.audit, 1);
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
    assert.equal(db.state.events, 1);
});

test("el tope individual limita a R$20 una recompensa del 1 % sobre R$3.000", async () => {
    const result = await acquisition.onOperationCompleted({ id: 25, phone: "5511999999999", monto: 3000, tipo: "brl_cup" }, makeEligibilityDb(3000));
    assert.equal(result.rewardBRL, 20);
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
    await assert.rejects(() => acquisition.saveProgramConfig({ enabled: true, rewardPct: 1, maxRewardBRL: 10, campaignLimitBRL: 100, periodLimitBRL: 100, acknowledgeUnknownNetProfit: true }, "admin"), /configuración aprobada del piloto es fija/);
    await assert.rejects(() => acquisition.saveProgramConfig({ enabled: true, rewardPct: 1, maxRewardBRL: 20, campaignLimitBRL: 200, periodLimitBRL: 200 }, "admin"), /rentabilidad neta seguirá siendo desconocida/);
});

test("enlace wa.me codifica mensaje y no contiene teléfono administrativo ni datos internos", () => {
    const link = acquisition.referralShareLink("AB23456789", "+55 (11) 98888-7777");
    assert.equal(link, "https://wa.me/5511988887777?text=Hola%2C%20quiero%20registrarme%20con%20c%C3%B3digo%20de%20referido%20AB23456789");
    assert.equal(acquisition.referralShareLink("AB23456789", null), null);
});

test("reserva el máximo de R$20 de forma serializada; con R$200 solo admite diez referidos", async () => {
    const db = makeLinkDb();
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, index) => acquisition.recordReferralLink({
        referredPhone: `55119999999${String(index).padStart(2, "0")}`, code: "AB23456789", evidenceNote: "Código enviado", customerWasNew: true
    }, db)));
    assert.equal(outcomes.filter(item => item.linked).length, 10);
    assert.equal(outcomes.filter(item => item.reason === "BUDGET_EXHAUSTED").length, 2);
    assert.equal(db.state.committed, 200);
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

test("la interfaz y rutas administrativas no contienen ejecución automática de campañas ni pagos", () => {
    const router = fs.readFileSync(path.join(__dirname, "../src/routes/content-library.js"), "utf8");
    const ui = fs.readFileSync(path.join(__dirname, "../public/content-center.html"), "utf8");
    assert.match(router, /acquisition\/referrals\/:id\/:action/);
    assert.match(ui, /Registrar liquidación manual/);
    assert.match(ui, /Borrador preparado, no enviado/);
    assert.doesNotMatch(router, /enviarMensaje|enviarSeguro|pagarRecompensa/);
});
