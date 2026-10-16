"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const queue = require("../src/services/commercial-outbound-queue");

function workerDb({ paused = false, sentToday = 0, lastSent = null, state = "PENDING", size = 50, source = "QUOTE_FOLLOWUP", optedOut = false, consent = null, active = false, blocked = false, windowOpen = true } = {}) {
    const now = new Date();
    const settings = { paused, daily_limit: 10, opening_time: "00:00", closing_time: "23:59", time_zone: "America/Sao_Paulo", consecutive_failures: 0 };
    const rows = Array.from({ length: size }, (_, i) => ({ id: i + 1, phone: `551199999${String(i).padStart(4, "0")}`, source, reason: "quote", strategy: "followup", content: "¿Quieres que revisemos tu cotización?", state, scheduled_at: new Date(now - 60000), expires_at: new Date(now.getTime() + 86400000), metadata: { quoteAt: now.toISOString(), approved: true }, recovery_attempt_id: null }));
    const db = { rows, sentToday,
        async connect() {
            return { async query(sql, params = []) {
                const q = String(sql).replace(/\s+/g, " ").trim();
                if (/pg_try_advisory_lock/.test(q)) return { rows: [{ locked: true }] };
                if (/pg_advisory_unlock/.test(q) || /^(BEGIN|COMMIT|ROLLBACK)/.test(q)) return { rows: [] };
                if (/UPDATE commercial_outbound_queue SET state='UNKNOWN'/.test(q)) return { rows: [] };
                if (/SELECT \* FROM commercial_outbound_settings/.test(q)) return { rows: [settings] };
                if (/SELECT \* FROM commercial_outbound_queue WHERE state='PENDING'/.test(q)) {
                    const pending = rows.find(item => item.state === "PENDING");
                    return { rows: pending ? [pending] : [] };
                }
                if (/SELECT c\.marketing_opt_out/.test(q)) return { rows: [{ marketing_opt_out: optedOut, marketing_consent_at: consent, pausa_hasta: null, estado_crm: "cotizado", fecha_cotizacion: new Date(rows[0].metadata.quoteAt), active_operation: active, whatsapp_window_open: windowOpen, blocked }] };
                if (/WITH cfg AS/.test(q)) return { rows: [{ now_at: now, local_now: now, today_open: new Date(now.getTime() - 3600000), today_close: new Date(now.getTime() + 3600000), tomorrow_open: new Date(now.getTime() + 86400000), attempts_today: sentToday, last_attempt: lastSent }] };
                if (/UPDATE commercial_outbound_queue SET state='SENDING'/.test(q)) { const item = rows.find(x => x.id === params[0]); item.state = "SENDING"; return { rows: [] }; }
                if (/UPDATE commercial_outbound_queue SET state='CANCELLED'/.test(q)) { const item = rows.find(x => x.id === params[0]); item.state = "CANCELLED"; return { rows: [] }; }
                if (/UPDATE commercial_outbound_queue SET contact_event_id/.test(q)) return { rows: [] };
                if (/UPDATE commercial_outbound_queue SET state=\$2/.test(q)) { const item = rows.find(x => x.id === params[0]); item.state = params[1]; item.error = params[2]; return { rows: [] }; }
                if (/UPDATE commercial_outbound_settings SET consecutive_failures/.test(q)) { settings.paused = params[0] ? settings.paused : settings.consecutive_failures + 1 >= 3; settings.consecutive_failures = params[0] ? 0 : settings.consecutive_failures + 1; return { rows: [] }; }
                throw new Error(`SQL no simulado en worker: ${q.slice(0, 100)}`);
            }, release() {} };
        }
    };
    return db;
}

test("máximo 10 por día: un batch de 50 solo puede despachar uno por tick", async () => {
    const db = workerDb({ size: 50 }); let sent = 0;
    const result = await queue.processNext({ pool: db, sendFn: async () => { sent++; return true; }, contactMemory: { claim: async () => ({ allowed: true, id: 3 }), settle: async () => "SENT" } });
    assert.equal(result.code, "SENT"); assert.equal(sent, 1);
    assert.equal(db.rows.filter(item => item.state === "SENT").length, 1);
    assert.equal(db.rows.filter(item => item.state === "PENDING").length, 49);
});

test("el límite diario lleno pospone el envío y nunca llama al proveedor", async () => {
    const db = workerDb({ sentToday: 10 }); let sent = 0;
    const result = await queue.processNext({ pool: db, sendFn: async () => { sent++; return true; } });
    assert.equal(result.code, "WAITING_FOR_SLOT"); assert.equal(sent, 0); assert.equal(db.rows[0].state, "PENDING");
});

test("no envía texto libre si cerró la ventana de WhatsApp y no existe adaptador de plantillas", async () => {
    const db = workerDb({ size: 1, windowOpen: false }); let sent = 0;
    const result = await queue.processNext({ pool: db, sendFn: async () => { sent++; return true; } });
    assert.equal(result.code, "CANCELLED");
    assert.equal(result.reason, "WHATSAPP_WINDOW_CLOSED");
    assert.equal(db.rows[0].state, "CANCELLED");
    assert.equal(sent, 0);
});

test("el panel diferencia intentos, aceptación de Z-API y envíos de la cola", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/services/commercial-outbound-queue.js"), "utf8");
    assert.match(source, /AS attempts_today/);
    assert.match(source, /provider_status = 'SENT'[\s\S]*AS sent_today/);
    assert.match(source, /commercial_outbound_queue q WHERE q\.state = 'SENT'[\s\S]*AS queue_sent_today/);
    const ui = fs.readFileSync(path.join(__dirname, "../public/content-operations.html"), "utf8");
    assert.match(ui, /Intentos hoy \(cuota\)/);
    assert.match(ui, /Aceptados por Z-API/);
    assert.match(ui, /Enviados por esta cola/);
    assert.match(ui, /no confirma entrega/i);
});

test("respeta el intervalo distribuido entre envíos aunque queden candidatos", async () => {
    const db = workerDb({ size: 3, sentToday: 1, lastSent: new Date(Date.now() - 60_000) }); let sent = 0;
    const result = await queue.processNext({ pool: db, sendFn: async () => { sent++; return true; } });
    assert.equal(result.code, "WAITING_FOR_SLOT"); assert.equal(sent, 0); assert.equal(db.rows[0].state, "PENDING");
});

test("la pausa administrativa detiene la cola, sin afectar rutas de atención", async () => {
    const db = workerDb({ paused: true }); let sent = 0;
    const result = await queue.processNext({ pool: db, sendFn: async () => { sent++; return true; } });
    assert.equal(result.code, "PAUSED"); assert.equal(sent, 0);
});

test("un resultado incierto queda UNKNOWN y no se reintenta", async () => {
    const db = workerDb({ size: 1 }); let sent = 0;
    const deps = { pool: db, sendFn: async () => { sent++; throw new Error("timeout"); }, contactMemory: { claim: async () => ({ allowed: true, id: 3 }), settle: async () => "UNKNOWN" } };
    const first = await queue.processNext(deps);
    assert.equal(first.code, "UNKNOWN"); assert.equal(db.rows[0].state, "UNKNOWN");
    const second = await queue.processNext(deps);
    assert.equal(second.code, "EMPTY"); assert.equal(sent, 1);
});

test("respuesta no confirmada por Z-API queda incierta y no genera reintentos automáticos", async () => {
    const db = workerDb({ size: 1 }); let sent = 0;
    const result = await queue.processNext({ pool: db, sendFn: async () => { sent++; return false; }, contactMemory: { claim: async () => ({ allowed: true, id: 3 }), settle: async () => "FAILED" } });
    assert.equal(result.code, "UNKNOWN"); assert.equal(db.rows[0].state, "UNKNOWN"); assert.equal(sent, 1);
});

for (const [name, options] of [
    ["opt-out", { optedOut: true }],
    ["operación activa", { active: true }],
    ["número bloqueado", { blocked: true }],
    ["marketing sin consentimiento verificable", { source: "CAMPAIGN", consent: null }]
]) {
    test(`despacho cancela antes de Z-API si existe ${name}`, async () => {
        const db = workerDb({ size: 1, ...options }); let sends = 0;
        const result = await queue.processNext({ pool: db, sendFn: async () => { sends++; return true; }, contactMemory: { claim: async () => ({ allowed: true, id: 3 }), settle: async () => "SENT" } });
        assert.equal(result.code, "CANCELLED"); assert.equal(sends, 0); assert.equal(db.rows[0].state, "CANCELLED");
    });
}

test("la cola exige consentimiento registrable para marketing y no admite opt-out", async () => {
    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "0041_commercial_outbound_queue.sql"), "utf8");
    const service = fs.readFileSync(path.join(__dirname, "..", "src/services/commercial-outbound-queue.js"), "utf8");
    assert.match(migration, /marketing_consent_at TIMESTAMPTZ/);
    assert.match(migration, /idx_commercial_outbound_one_pending_per_phone/);
    assert.match(service, /NO_VERIFIABLE_MARKETING_CONSENT/);
    assert.match(service, /OPTED_OUT/);
});

test("campañas, referidos y Director no pueden entrar a la cola sin aprobación explícita", async () => {
    const db = { connect: async () => { throw new Error("No debe tocar DB sin aprobación"); } };
    for (const source of ["CAMPAIGN", "REFERRAL", "DIRECTOR"]) {
        const result = await queue.enqueue({ phone: "5511999999999", source, reason: "test", strategy: "test", content: "test", idempotencyKey: `test-${source}` }, { pool: db });
        assert.deepEqual(result, { queued: false, code: "APPROVAL_REQUIRED" });
    }
});

test("las respuestas del cliente cancelan pendientes; cotización, PIX, entregas y tasas quedan fuera del dispatcher comercial", () => {
    const index = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    const scheduler = fs.readFileSync(path.join(__dirname, "..", "src/services/content-scheduler.js"), "utf8");
    assert.match(index, /cancelPendingForPhone\(phoneRaw, "CLIENT_REPLIED"\)/);
    assert.match(scheduler, /commercialOutboundQueue\.processNext/);
    assert.match(scheduler, /daily-rates-%/);
});

test("el control de operaciones expone cola y acciones autenticadas de pausa/reanudación", () => {
    const router = fs.readFileSync(path.join(__dirname, "..", "src/routes/content-operations.js"), "utf8");
    const ui = fs.readFileSync(path.join(__dirname, "..", "public/content-operations.html"), "utf8");
    assert.match(router, /verificarToken/); assert.match(router, /commercial-outbound\/settings/); assert.match(router, /commercial-outbound\/:action/);
    assert.match(ui, /commercialPendingCount/); assert.match(ui, /Pausar cola/); assert.match(ui, /Reanudar cola/);
});
