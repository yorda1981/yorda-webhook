"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const marketer = require("../src/services/director/automatic-marketer");

test("hook comercial solo admite preguntas neutras y sin afirmaciones promocionales", () => {
    assert.equal(marketer.assertSafeHook("¿Quieres saber cómo funciona una cotización?"), "¿Quieres saber cómo funciona una cotización?");
    assert.throws(() => marketer.assertSafeHook("¿Sabías que YORDA es la mejor opción?"), /pregunta neutral/);
    assert.throws(() => marketer.assertSafeHook("¿Quieres una tasa especial hoy?"), /promoción/);
    assert.equal(marketer.tokenSimilarity("Solicita una cotización para Cuba", "Solicita una cotización para Cuba"), 1);
    assert.ok(marketer.tokenSimilarity("Solicita una cotización para Cuba", "Pide una cotización para enviar a Cuba") > 0.2);
});

test("programa de referidos solo se ofrece con configuración y presupuesto vigentes", async () => {
    const now = new Date("2026-10-23T12:00:00Z");
    const acquisition = {
        getProgramConfig: async () => ({ enabled: true, expires_at: "2026-11-20T00:00:00Z", reward_pct: 1, max_reward_brl: 50, period_limit_brl: 500, campaign_limit_brl: 500 }),
        getReferralSummary: async () => ({ costo_comprometido_brl: 0 })
    };
    const loaded = await marketer.loadCategoryFacts("referidos", {}, now, { acquisition });
    assert.equal(loaded.available, true);
    assert.equal(loaded.referral.config.reward_pct, 1);
    const exhausted = await marketer.loadCategoryFacts("referidos", {}, now, { acquisition: {
        ...acquisition, getReferralSummary: async () => ({ costo_comprometido_brl: 460 })
    } });
    assert.equal(exhausted.available, false);
    const inactive = await marketer.loadCategoryFacts("referidos", {}, now, { acquisition: {
        ...acquisition, getProgramConfig: async () => ({ ...await acquisition.getProgramConfig(), enabled: false })
    } });
    assert.equal(inactive.available, false);
});

test("un marketero desactivado no consume IA ni crea publicaciones", async () => {
    let calls = 0;
    const result = await marketer.runDaily({ marketerConfig: { enabled: false } }, { llm: { completeJson: async () => { calls++; } } });
    assert.deepEqual(result, { status: "DESACTIVADO" });
    assert.equal(calls, 0);
});

test("una categoría permitida genera, valida y programa una sola publicación futura", async () => {
    const now = new Date("2026-10-23T10:00:00Z"); // 07:00 en São Paulo
    const queries = [];
    let scheduled = null;
    let approved = false;
    let draft;
    let promoToday = false;
    const run = async (sql, params = []) => {
        const q = String(sql).replace(/\s+/g, " ").trim();
        queries.push({ q, params });
        if (q.startsWith("SELECT EXISTS")) return { rows: [{ exists: promoToday }] };
        if (/SELECT id,estado FROM content_items/.test(q)) return { rows: [] };
        if (/SELECT categoria, MAX\(creado_at\)/.test(q)) return { rows: [] };
        if (/SELECT cr\.cuerpo FROM content_items/.test(q)) return { rows: [] };
        if (/SELECT marketer_enabled,marketer_categories/.test(q)) return { rows: [{ marketer_enabled: true, marketer_categories: ["captacion"] }] };
        return { rows: [] };
    };
    const db = { query: run, connect: async () => ({ query: run, release() {} }) };
    const library = {
        createDirectorDraft: async input => { draft = input; return { id: 4 }; },
        getContentAsset: async () => ({ id: 4, estado: "BORRADOR", cuerpo: draft.cuerpo, grupo: draft.grupo,
            categoria: draft.categoria, origenSistema: draft.origenSistema, revisionId: 1, fuentes: draft.fuentes }),
        resolveDraft: async () => { approved = true; return { changed: true }; }
    };
    const result = await marketer.runDaily({ db, now, marketerConfig: { enabled: true, categories: ["captacion"], time: "18:00" } }, {
        destinations: { getDefaultDestination: async () => ({ destinationId: 2, type: "WHATSAPP_GROUP", active: true, validatedAt: now }) },
        funnel: { obtenerResumen: async () => ({ sin_avance_observable_24h: 0 }) },
        llm: { completeJson: async () => ({ data: { gancho: "¿Quieres saber cuánto recibiría tu familia?", hechosUsados: ["quote_choices"], aporte: "Ayuda a conocer el resultado antes de decidir si continúa." } }) },
        library,
        scheduler: { schedulePublication: async input => { scheduled = input; promoToday = true; return { schedule: { scheduleId: 8 } }; } }
    });
    assert.equal(result.status, "PROGRAMADO");
    assert.equal(approved, true);
    assert.equal(draft.grupo, "comercial");
    assert.equal(draft.origenSistema, "marketer-2026-10-23");
    assert.equal(scheduled.idempotencyKey, "marketer-2026-10-23");
    assert.equal(scheduled.programadaPara, "2026-10-23T21:00:00.000Z");
    assert.match(draft.cuerpo, /Puedes pedir una cotización/);
    assert.equal(queries.some(x => x.params.includes("CONTENT_MARKETER_VALIDATED")), true);
});

test("duplicados diarios y contenido similar se excluyen sin publicar", async () => {
    const now = new Date("2026-10-23T10:00:00Z");
    let aiCalls = 0;
    const result = await marketer.runDaily({ db: { query: async sql => String(sql).includes("SELECT EXISTS") ? { rows: [{ exists: true }] } : { rows: [] } }, now,
        marketerConfig: { enabled: true, categories: ["captacion"], time: "18:00" } }, {
        destinations: { getDefaultDestination: async () => ({ type: "WHATSAPP_GROUP", active: true, validatedAt: now }) },
        llm: { completeJson: async () => { aiCalls++; } }
    });
    assert.equal(result.status, "SIN_PUBLICACION");
    assert.equal(aiCalls, 0);
});

test("migración deja el control apagado y el panel ofrece controles integrados", () => {
    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations/0044_automatic_marketer.sql"), "utf8");
    assert.match(migration, /marketer_enabled BOOLEAN NOT NULL DEFAULT FALSE/);
    assert.match(migration, /marketer_time TIME NOT NULL DEFAULT TIME '18:00'/);
    assert.doesNotMatch(migration, /CREATE TABLE|DELETE FROM|UPDATE content_items/i);
    const panel = fs.readFileSync(path.join(__dirname, "..", "public/content-operations.html"), "utf8");
    assert.match(panel, /automatic-marketer\/settings/);
    assert.match(panel, /value="opciones-recepcion"/);
});

test("el contador de publicaciones aceptadas conserva la clave camelCase que consume el panel", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src/services/director/automatic-marketer.js"), "utf8");
    assert.match(source, /AS "providerAccepted"/);
});
