"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const acquisition = require("../src/services/customer-acquisition");

function makeEligibilityDb() {
    const state = { referral: { id: 7, status: "PENDIENTE", reward_pct: "1.00" }, updates: 0, events: 0 };
    const client = {
        async query(sql, params = []) {
            const q = String(sql).replace(/\s+/g, " ").trim();
            if (q === "BEGIN" || q === "COMMIT" || q === "ROLLBACK" || q.includes("pg_advisory_xact_lock")) return { rows: [] };
            if (q.includes("SELECT id, monto, tipo, completed_at FROM operations")) return { rows: [{ id: 25, monto: "500", tipo: "brl_cup", completed_at: new Date() }] };
            if (q.includes("SELECT * FROM customer_referrals WHERE referred_phone")) return { rows: [{ ...state.referral }] };
            if (q.includes("SELECT * FROM referral_program_config")) return { rows: [{ enabled: true, reward_pct: "1.00", max_reward_brl: "20", campaign_limit_brl: "100", period_limit_brl: "50", enabled_at: new Date("2026-01-01") }] };
            if (q.includes("SELECT COALESCE(SUM(reward_brl),0) AS total FROM customer_referrals")) return { rows: [{ total: "0" }] };
            if (q.includes("UPDATE customer_referrals SET first_operation_id")) {
                state.updates++;
                state.referral = { ...state.referral, first_operation_id: params[1], first_amount_brl: params[2], reward_brl: params[3], status: params[4] };
                return { rows: [] };
            }
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
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q)) return { rows: [] };
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

function makeLinkDb({ self = false } = {}) {
    const state = { linked: null, audit: 0, locks: new Map() };
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
                    if (q.includes("SELECT enabled, reward_pct FROM referral_program_config")) return { rows: [{ enabled: true, reward_pct: "1" }] };
                    if (q.includes("SELECT phone FROM customers WHERE phone =")) return { rows: [{ phone: "5511999999999" }] };
                    if (q.includes("SELECT phone FROM customers WHERE referral_code")) return { rows: [{ phone: self ? "5511999999999" : "5511888888888" }] };
                    if (q.includes("SELECT id FROM operations")) return { rows: [] };
                    if (q.includes("SELECT id, referrer_phone FROM customer_referrals")) return { rows: state.linked ? [state.linked] : [] };
                    if (q.includes("INSERT INTO customer_referrals")) {
                        if (state.linked) { const error = new Error("duplicate"); error.code = "23505"; throw error; }
                        state.linked = { id: 1, referrer_phone: params[1] };
                        return { rows: [{ id: 1, status: "PENDIENTE", evidence_note: params[4] }] };
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

test("vincula código válido antes de la primera remesa y evita self-referral, asociación retroactiva y códigos inválidos", async () => {
    const db = makeLinkDb();
    const linked = await acquisition.recordReferralLink({ referredPhone: "5511999999999", code: "AB23456789", evidenceNote: "Código declarado" }, db);
    assert.equal(linked.linked, true);
    assert.equal(db.state.audit, 1);
    const duplicate = await acquisition.recordReferralLink({ referredPhone: "5511999999999", code: "AB23456789", evidenceNote: "Otra evidencia" }, db);
    assert.equal(duplicate.reason, "ALREADY_LINKED");
    assert.equal((await acquisition.recordReferralLink({ referredPhone: "5511999999999", code: "AB23456789" }, makeLinkDb({ self: true }))).reason, "SELF_REFERRAL");
    const invalidDb = { connect: async () => { throw new Error("No debe acceder a DB"); } };
    assert.equal((await acquisition.recordReferralLink({ referredPhone: "x", code: "BAD" }, invalidDb)).reason, "INVALID_CODE_FORMAT");
});

test("dos registros concurrentes para el mismo referido dejan una sola vinculación auditada", async () => {
    const db = makeLinkDb();
    const input = { referredPhone: "5511999999999", code: "AB23456789", evidenceNote: "Declaración en WhatsApp" };
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

test("operaciones de prueba, canceladas u otros servicios nunca generan recompensa", async () => {
    const db = { connect: async () => { throw new Error("No debe tocar DB"); } };
    assert.deepEqual(await acquisition.onOperationCompleted({ id: 1, phone: "x", tipo: "recarga_nacional", monto: 100 }, db), { processed: false, reason: "NOT_ELIGIBLE_REMITTANCE" });
    const source = fs.readFileSync(path.join(__dirname, "../src/services/customer-acquisition.js"), "utf8");
    assert.match(source, /COALESCE\(es_prueba,FALSE\) = FALSE/);
    const migration = fs.readFileSync(path.join(__dirname, "../migrations/0037_referrals_and_second_remittance.sql"), "utf8");
    assert.match(migration, /es_prueba BOOLEAN NOT NULL DEFAULT FALSE/);
});

test("no se puede activar el programa sin topes económicos ni reconocer margen neto desconocido", async () => {
    const db = { query: async sql => String(sql).includes("SELECT * FROM referral_program_config")
        ? { rows: [{ enabled: false }] }
        : { rows: [] } };
    await assert.rejects(() => acquisition.saveProgramConfig({ enabled: true, rewardPct: 1 }, "admin", db), /configura el máximo/);
    await assert.rejects(() => acquisition.saveProgramConfig({ enabled: true, rewardPct: 1, maxRewardBRL: 10, campaignLimitBRL: 100, periodLimitBRL: 100 }, "admin", db), /rentabilidad neta seguirá siendo desconocida/);
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
