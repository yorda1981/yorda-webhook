"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    normalizeIdempotencyKey,
    finishPublication,
    preparePublication,
    publishSelectedContent
} = require("../src/services/content-publisher");

const selected = {
    contentId: 10,
    revisionId: 20,
    revision: 2,
    titulo: "Activo",
    cuerpo: "*Mensaje* reutilizable",
    idioma: "es",
    prioridad: 80
};
const rendered = {
    channel: "whatsapp_admin",
    destination: "ADMIN_PHONE",
    renderedBody: "Mensaje reutilizable"
};

function selector() {
    return { normalizeLanguage: (value) => value || "es" };
}

function prepared() {
    return {
        publication: { publicationId: 30, contentId: 10, revisionId: 20, estado: "PUBLICANDO" },
        selected,
        rendered,
        attemptId: 40
    };
}

function finalizationDb() {
    const calls = [];
    const current = {
        id: "30", content_item_id: "10", revision_id: "20", estado: "PUBLICANDO",
        idempotency_key: "publish-1", publicada_at: null, error: null, attempt_id: "40"
    };
    const client = {
        async query(sql, params = []) {
            const compact = String(sql).replace(/\s+/g, " ").trim();
            calls.push({ sql: compact, params });
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(compact)) return { rows: [] };
            if (compact.startsWith("SELECT cp.id")) return { rows: [current] };
            if (compact.startsWith("UPDATE content_publications") && compact.includes("RETURNING publicada_at")) {
                return { rows: [{ publicada_at: "2026-10-11T20:00:00.000Z" }] };
            }
            return { rows: [] };
        },
        release() { calls.push({ sql: "RELEASE", params: [] }); }
    };
    return { calls, async connect() { return client; } };
}

test("idempotency key es obligatoria, estable y acotada", () => {
    assert.equal(normalizeIdempotencyKey("  publish-123  "), "publish-123");
    assert.throws(() => normalizeIdempotencyKey(""), { code: "CONTENT_PUBLISHER_VALIDATION" });
    assert.throws(() => normalizeIdempotencyKey("x".repeat(161)), { code: "CONTENT_PUBLISHER_VALIDATION" });
});

test("flujo exitoso selecciona, envía exclusivamente al admin y finaliza como publicado", async () => {
    const calls = [];
    const result = await publishSelectedContent(
        { idioma: "es", idempotencyKey: "publish-ok" },
        {
            pool: {}, selector: selector(),
            resolveDestinationFn: async () => ({ channel: "whatsapp_admin", reference: "ADMIN_PHONE", address: "5511999999999" }),
            prepareFn: async (input) => { calls.push(["prepare", input]); return prepared(); },
            sendDestinationFn: async (destination, body) => { calls.push(["send", destination.address, body]); return true; },
            finishFn: async (input) => {
                calls.push(["finish", input]);
                return { publicationId: 30, estado: "PUBLICADA" };
            }
        }
    );
    assert.equal(result.ok, true);
    assert.equal(result.code, "PUBLISHED");
    assert.deepEqual(calls[1], ["send", "5511999999999", "Mensaje reutilizable"]);
    assert.equal(calls[2][1].success, true);
    assert.equal(result.selected.revisionId, 20);
    assert.equal(result.rendered.renderedBody, "Mensaje reutilizable");
});

test("fallo confirmado de envío finaliza como fallido", async () => {
    let finishInput;
    const result = await publishSelectedContent(
        { idioma: "es", idempotencyKey: "publish-fail" },
        {
            pool: {}, selector: selector(), resolveDestinationFn: async () => ({ address: "5511999999999" }),
            prepareFn: async () => prepared(),
            sendDestinationFn: async () => false,
            finishFn: async (input) => {
                finishInput = input;
                return { publicationId: 30, estado: "FALLIDA" };
            }
        }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "SEND_FAILED");
    assert.equal(finishInput.success, false);
    assert.match(String(finishInput.errorMessage), /proveedor no confirmó/i);
});

test("sin destino válido no selecciona, registra ni intenta enviar", async () => {
    let touched = false;
    const result = await publishSelectedContent(
        { idioma: "es", idempotencyKey: "publish-no-admin" },
        {
            pool: {}, selector: selector(), resolveDestinationFn: async () => null,
            prepareFn: async () => { touched = true; },
            sendDestinationFn: async () => { touched = true; }
        }
    );
    assert.equal(result.code, "DESTINATION_NOT_FOUND");
    assert.equal(touched, false);
});

test("repetir idempotency key no vuelve a enviar", async () => {
    let sends = 0;
    const result = await publishSelectedContent(
        { idioma: "es", idempotencyKey: "publish-duplicate" },
        {
            pool: {}, selector: selector(), resolveDestinationFn: async () => ({ address: "5511999999999" }),
            prepareFn: async () => ({ existing: { publicationId: 30, estado: "PUBLICADA" } }),
            sendDestinationFn: async () => { sends++; return true; }
        }
    );
    assert.equal(result.code, "ALREADY_REGISTERED");
    assert.equal(result.ok, true);
    assert.equal(sends, 0);
});

test("finalización exitosa actualiza publicación, intento y ultima_utilizacion_at en la misma transacción", async () => {
    const db = finalizationDb();
    const result = await finishPublication({ publicationId: 30, success: true }, db);
    assert.equal(result.estado, "PUBLICADA");
    assert.equal(result.publicadaAt, "2026-10-11T20:00:00.000Z");
    assert.equal(db.calls.filter((call) => call.sql.startsWith("UPDATE content_items")).length, 1);
    assert.match(db.calls.find((call) => call.sql.startsWith("UPDATE content_publication_attempts")).sql, /estado = 'ENVIADO'/);
    const events = db.calls.find((call) => call.sql.startsWith("INSERT INTO content_events"));
    assert.match(events.sql, /CONTENT_ATTEMPT_SENT/);
    assert.match(events.sql, /CONTENT_PUBLICATION_PUBLISHED/);
    assert.match(events.sql, /CONTENT_ASSET_USED/);
});

test("finalización fallida nunca actualiza ultima_utilizacion_at", async () => {
    const db = finalizationDb();
    const result = await finishPublication({ publicationId: 30, success: false, errorMessage: "Z-API caída" }, db);
    assert.equal(result.estado, "FALLIDA");
    assert.equal(db.calls.some((call) => call.sql.startsWith("UPDATE content_items")), false);
    assert.match(db.calls.find((call) => call.sql.startsWith("UPDATE content_publication_attempts")).sql, /estado = 'FALLIDO'/);
    const events = db.calls.find((call) => call.sql.startsWith("INSERT INTO content_events"));
    assert.match(events.sql, /CONTENT_ATTEMPT_FAILED/);
    assert.match(events.sql, /CONTENT_PUBLICATION_FAILED/);
    assert.doesNotMatch(events.sql, /CONTENT_ASSET_USED/);
});

test("motor usa los módulos aprobados y no contiene canales o automatizaciones adicionales", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "content-publisher.js"), "utf8");
    assert.match(source, /require\("\.\/content-selector"\)/);
    assert.match(source, /require\("\.\/content-renderer"\)/);
    assert.match(source, /require\("\.\/content-center-states"\)/);
    assert.match(source, /INSERT INTO content_publications/);
    assert.match(source, /INSERT INTO content_publication_attempts/);
    assert.doesNotMatch(source, /telegram|campaña|setInterval|setTimeout|Math\.random/i);
});

test("endpoint de publicación es escritura autenticada y no existe una pantalla nueva", () => {
    const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "content-library.js"), "utf8");
    assert.match(routes, /router\.post\("\/publish", adminWriteLimiter, verificarToken/);
    const publicFiles = fs.readdirSync(path.join(__dirname, "..", "public"));
    assert.equal(publicFiles.filter((name) => /publish|publicacion/i.test(name)).length, 0);
});

test("publicar desde la Biblioteca pasa el activo al selector dentro del mismo flujo", async () => {
    let criteria;
    const client = {
        async query(sql) {
            const compact = String(sql).replace(/\s+/g, " ").trim();
            if (compact.startsWith("SELECT id, content_item_id")) return { rows: [] };
            return { rows: [] };
        },
        release() {}
    };
    await preparePublication({
        idioma: "es",
        idempotencyKey: "library-10-now",
        contentId: 10,
        selector: { selectContent: async (received) => { criteria = received; return null; } },
        destination: { channel: "whatsapp_group", reference: "120363019502650977-group" }
    }, { connect: async () => client });
    assert.deepEqual(criteria, { idioma: "es", contentId: 10 });
});
