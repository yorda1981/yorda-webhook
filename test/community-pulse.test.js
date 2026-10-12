"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pulse = require("../src/services/community-pulse");
const { createContentOperationsRouter } = require("../src/routes/content-operations");

const GROUP = "120363019502650977-group";
const root = path.join(__dirname, "..");
const activeGroup = async () => ({ type: "WHATSAPP_GROUP", externalId: GROUP });

// Pool falso con transacciones: registra cada consulta y responde con `handler`.
function fakePool(handler) {
    const calls = [];
    const run = async (sql, params = []) => {
        const compact = String(sql).replace(/\s+/g, " ").trim();
        calls.push({ sql: compact, params });
        return (await handler(compact, params)) || { rows: [] };
    };
    return {
        calls,
        query: run,
        connect: async () => ({ query: run, release() {} })
    };
}

test("normaliza participantes: dígitos para teléfonos y LID intacto", () => {
    assert.equal(pulse.normalizeParticipant("5511999999999"), "5511999999999");
    assert.equal(pulse.normalizeParticipant("5511999999999@c.us"), "5511999999999");
    assert.equal(pulse.normalizeParticipant("+55 (11) 99999-9999"), "5511999999999");
    assert.equal(pulse.normalizeParticipant("123456789@lid"), "123456789@lid");
    assert.equal(pulse.normalizeParticipant(""), null);
});

test("clasifica el tipo de mensaje entrante sin leer su contenido", () => {
    assert.equal(pulse.inboundMessageType({ text: { message: "hola" } }), "texto");
    assert.equal(pulse.inboundMessageType({ image: { imageUrl: "x" } }), "imagen");
    assert.equal(pulse.inboundMessageType({ document: {} }), "documento");
    assert.equal(pulse.inboundMessageType({ messageType: "ptt" }), "audio");
});

test("registra un alta por participante del grupo activo con clave idempotente", async () => {
    const db = fakePool(sql => (sql.startsWith("INSERT INTO community_member_events") ? { rows: [{ id: 1 }] } : null));
    const result = await pulse.recordGroupNotification({
        isGroup: true, phone: GROUP, messageId: "MSG1", momment: 1760000000000,
        notification: "GROUP_PARTICIPANT_INVITE", notificationParameters: ["5511999999999", "5511888888888"]
    }, { pool: db, getDefaultDestination: activeGroup });
    assert.equal(result.recorded, 2);
    const inserts = db.calls.filter(c => c.sql.startsWith("INSERT INTO community_member_events"));
    assert.deepEqual(inserts.map(c => c.params[5]), ["MSG1:5511999999999", "MSG1:5511888888888"]);
    assert.ok(inserts.every(c => c.params[2] === "ALTA" && c.params[3] === "WEBHOOK"));
    assert.equal(inserts[0].params[6].getTime(), 1760000000000);
    assert.equal(db.calls.filter(c => c.sql.startsWith("INSERT INTO community_members")).length, 2);
});

test("un callback repetido no vuelve a cambiar el estado del miembro", async () => {
    const db = fakePool(() => null); // ON CONFLICT DO NOTHING: no devuelve fila
    const result = await pulse.recordGroupNotification({
        isGroup: true, phone: GROUP, messageId: "MSG1",
        notification: "GROUP_PARTICIPANT_LEAVE", notificationParameters: ["5511999999999"]
    }, { pool: db, getDefaultDestination: activeGroup });
    assert.equal(result.recorded, 0);
    assert.ok(!db.calls.some(c => c.sql.startsWith("UPDATE community_members")));
});

test("ignora eventos de otros grupos y mensajes que no son de participantes", async () => {
    const db = fakePool(() => assert.fail("no debe escribir"));
    assert.equal((await pulse.recordGroupNotification({ isGroup: true, phone: "999-group", notification: "GROUP_PARTICIPANT_ADD", notificationParameters: ["55119"] }, { pool: db, getDefaultDestination: activeGroup })).ignored, "NOT_ACTIVE_GROUP");
    assert.equal((await pulse.recordGroupNotification({ isGroup: true, phone: GROUP, notification: "GROUP_CREATE" }, { pool: db, getDefaultDestination: activeGroup })).ignored, "NOT_PARTICIPANT_EVENT");
    assert.equal((await pulse.recordGroupNotification({ isGroup: true, phone: GROUP, notification: "GROUP_PARTICIPANT_ADD", notificationParameters: ["55119"] }, { pool: db, getDefaultDestination: async () => null })).ignored, "NOT_ACTIVE_GROUP");
});

test("la primera lectura es línea base: miembros sin altas", async () => {
    const db = fakePool(sql => {
        if (sql.startsWith("SELECT COUNT(*) FILTER")) return { rows: [{ altas: 0, bajas: 0 }] };
        return null;
    });
    const result = await pulse.takeDailySnapshot({
        pool: db, getDefaultDestination: activeGroup, now: new Date("2026-10-12T12:00:00Z"),
        getGroupMetadata: async () => ({ participants: [{ phone: "5511999999999" }, { phone: "5511888888888" }] })
    });
    assert.equal(result.baseline, true);
    assert.equal(result.miembros, 2);
    const baseline = db.calls.find(c => c.sql.includes("unnest($2::text[])"));
    assert.deepEqual(baseline.params[1].sort(), ["5511888888888", "5511999999999"]);
    assert.ok(!db.calls.some(c => c.sql.startsWith("INSERT INTO community_member_events")));
    const snapshot = db.calls.find(c => c.sql.startsWith("INSERT INTO community_snapshots"));
    assert.deepEqual(snapshot.params.slice(1, 5), ["2026-10-12", 2, 0, 0]);
});

test("las lecturas siguientes registran como altas y bajas lo que el webhook no informó", async () => {
    const db = fakePool(sql => {
        if (sql.startsWith("SELECT tomada_at")) return { rows: [{ tomada_at: new Date("2026-10-11T09:00:00Z") }] };
        if (sql.startsWith("SELECT phone FROM community_members")) return { rows: [{ phone: "5511999999999" }, { phone: "5511777777777" }] };
        if (sql.startsWith("INSERT INTO community_member_events")) return { rows: [{ id: 9 }] };
        if (sql.startsWith("SELECT COUNT(*) FILTER")) return { rows: [{ altas: 1, bajas: 1 }] };
        return null;
    });
    const result = await pulse.takeDailySnapshot({
        pool: db, getDefaultDestination: activeGroup, now: new Date("2026-10-12T12:00:00Z"),
        getGroupMetadata: async () => ({ participants: [{ phone: "5511999999999" }, { phone: "5511888888888" }] })
    });
    assert.deepEqual({ altas: result.altas, bajas: result.bajas, baseline: result.baseline }, { altas: 1, bajas: 1, baseline: false });
    const events = db.calls.filter(c => c.sql.startsWith("INSERT INTO community_member_events"));
    assert.deepEqual(events.map(c => [c.params[1], c.params[2], c.params[3]]), [
        ["5511888888888", "ALTA", "LECTURA"],
        ["5511777777777", "BAJA", "LECTURA"]
    ]);
    assert.ok(db.calls.some(c => c.sql.startsWith("DELETE FROM bot_inbound_messages") && c.sql.includes("180 days")));
});

test("no repite la lectura del día y falla de forma explícita si Z-API no responde", async () => {
    const taken = fakePool(sql => (sql.startsWith("SELECT 1 FROM community_snapshots") ? { rows: [{}] } : null));
    assert.equal((await pulse.takeDailySnapshot({ pool: taken, getDefaultDestination: activeGroup, getGroupMetadata: async () => assert.fail("no debe leer") })).skipped, "ALREADY_TAKEN");
    const empty = fakePool(() => null);
    await assert.rejects(pulse.takeDailySnapshot({ pool: empty, getDefaultDestination: activeGroup, getGroupMetadata: async () => null }), /participantes/);
});

test("el mensaje entrante guarda solo teléfono y tipo", async () => {
    const db = fakePool(() => null);
    await pulse.recordInboundMessage("5511999999999", "texto", db);
    assert.deepEqual(db.calls[0].params, ["5511999999999", "texto"]);
    const migration = fs.readFileSync(path.join(root, "migrations", "0029_community_pulse.sql"), "utf8");
    const table = migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS bot_inbound_messages"));
    const columns = table.slice(table.indexOf("(") + 1, table.indexOf(");"));
    assert.doesNotMatch(columns, /message|texto|cuerpo|body|content/i);
});

test("el mes de la Métrica Norte se cuenta en calendario de São Paulo", () => {
    const { start, end } = pulse.monthBoundsSaoPaulo(new Date("2026-11-01T02:00:00Z")); // 31/10 23:00 en São Paulo
    assert.equal(start.toISOString(), "2026-10-01T03:00:00.000Z");
    assert.equal(end.toISOString(), "2026-11-01T03:00:00.000Z");
});

test("el Centro de Operaciones no falla si el Pulso falla ni lo consulta con el esquema pendiente", async () => {
    const call = async (router) => {
        const layer = router.stack.find(l => l.route?.path === "/");
        const handler = layer.route.stack.at(-1).handle;
        let body;
        await handler({}, { json: b => { body = b; }, status() { return this; } });
        return body;
    };
    const service = { getOperationsSnapshot: async () => ({ counts: {} }) };
    const failing = await call(createContentOperationsRouter({ service, pulse: { getPulseMetrics: async () => { throw new Error("boom"); } } }));
    assert.equal(failing.operations.pulse, null);
    const pending = await call(createContentOperationsRouter({ service, getSchemaStatus: () => ({ estado: "PENDIENTE", pendientes: [] }), pulse: { getPulseMetrics: async () => assert.fail("no debe consultar") } }));
    assert.equal(pending.operations.pulse, null);
});

test("index.js: eventos del grupo antes de ignorar grupos, mensajes tras el bloqueo y Pulso tras el esquema", () => {
    const index = fs.readFileSync(path.join(root, "index.js"), "utf8");
    const notification = index.indexOf("communityPulse.recordGroupNotification(body)");
    const groupReturn = index.indexOf('if (body.isGroup || String(phoneRaw).includes("-group")) return;');
    assert.ok(notification > 0 && notification < groupReturn);
    const inbound = index.indexOf("communityPulse.recordInboundMessage(phoneRaw");
    assert.ok(inbound > index.indexOf("blockedNumbers.estaBloqueado(phoneRaw)"));
    assert.ok(inbound > index.indexOf("yaFueProcesado(messageId)"));
    assert.match(index, /marketingSchedulerStarted = true;\s*communityPulse\.startCommunityPulse\(\);/);
});
