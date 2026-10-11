"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const destinations = require("../src/services/content-destinations");
const adapters = require("../src/services/content-output-adapters");
const { preparePublication, publishSelectedContent } = require("../src/services/content-publisher");

test("registra persistentemente un grupo validado y conserva su identificador", async () => {
    let query;
    const destination = await destinations.registerWhatsAppGroup(
        { groupId: "120363019502650977-group" },
        {
            validateGroup: async () => ({ phone: "120363019502650977-group", subject: "Clientes YORDA" }),
            pool: { query: async (sql, params) => {
                query = { sql, params };
                return { rows: [{ id: "7", tipo: "WHATSAPP_GROUP", external_id: params[1], nombre: params[2], activo: true, validado_at: "2026-10-11" }] };
            } }
        }
    );
    assert.equal(destination.destinationId, 7);
    assert.equal(destination.externalId, "120363019502650977-group");
    assert.match(query.sql, /CONTENT_DESTINATION_VALIDATED/);
});

test("rechaza un grupo que el proveedor no puede validar", async () => {
    await assert.rejects(
        destinations.registerWhatsAppGroup(
            { groupId: "120363019502650977-group" },
            { validateGroup: async () => null, pool: { query: async () => assert.fail("no debe persistir") } }
        ),
        { code: "CONTENT_DESTINATION_VALIDATION" }
    );
});

test("adaptador resuelve un grupo activo y envía al identificador persistido", async () => {
    const destination = await adapters.resolveOutputDestination(
        { destinationId: 7 },
        { getDestination: async () => ({ type: "WHATSAPP_GROUP", externalId: "120363019502650977-group" }) }
    );
    let sent;
    const ok = await adapters.sendToDestination(destination, "Mensaje", {
        sendFn: async (address, body) => { sent = { address, body }; return true; }
    });
    assert.equal(ok, true);
    assert.deepEqual(sent, { address: "120363019502650977-group", body: "Mensaje" });
});

test("publicador reutiliza el mismo flujo y registra canal y destino de grupo", async () => {
    let prepareInput;
    let sent;
    const group = { channel: "whatsapp_group", reference: "120363019502650977-group", address: "120363019502650977-group" };
    const result = await publishSelectedContent(
        { idioma: "es", idempotencyKey: "group-publication-1", destinationId: 7 },
        {
            pool: {},
            selector: { normalizeLanguage: value => value },
            resolveDestinationFn: async () => group,
            prepareFn: async input => {
                prepareInput = input;
                return {
                    publication: { publicationId: 30 },
                    selected: { contentId: 10, revisionId: 20 },
                    rendered: { renderedBody: "Mismo contenido" }
                };
            },
            sendDestinationFn: async (destination, body) => { sent = { destination, body }; return true; },
            finishFn: async () => ({ publicationId: 30, estado: "PUBLICADA" })
        }
    );
    assert.equal(result.code, "PUBLISHED");
    assert.equal(prepareInput.destination, group);
    assert.equal(sent.destination, group);
    assert.equal(sent.body, "Mismo contenido");
});

test("preparación persiste y traza el canal y grupo exactos", async () => {
    const calls = [];
    const client = {
        async query(sql, params = []) {
            const compact = String(sql).replace(/\s+/g, " ").trim();
            calls.push({ sql: compact, params });
            if (compact.startsWith("SELECT id, content_item_id")) return { rows: [] };
            if (compact.startsWith("INSERT INTO content_publications")) {
                return { rows: [{ id: "30", content_item_id: "10", revision_id: "20", canal: params[2], destino_ref: params[3], estado: "PROGRAMADA", idempotency_key: params[6] }] };
            }
            if (compact.startsWith("INSERT INTO content_publication_attempts")) return { rows: [{ id: "40" }] };
            return { rows: [] };
        },
        release() {}
    };
    const result = await preparePublication({
        idioma: "es",
        idempotencyKey: "group-history-1",
        selector: { selectContent: async () => ({ contentId: 10, revisionId: 20, cuerpo: "*Mensaje*" }) },
        destination: { channel: "whatsapp_group", reference: "120363019502650977-group" }
    }, { connect: async () => client });
    const insert = calls.find(call => call.sql.startsWith("INSERT INTO content_publications"));
    assert.equal(insert.params[2], "whatsapp_group");
    assert.equal(insert.params[3], "120363019502650977-group");
    const createdEvent = calls.find(call => call.sql.includes("CONTENT_PUBLICATION_CREATED"));
    assert.match(createdEvent.params[1], /"channel":"whatsapp_group"/);
    assert.match(createdEvent.params[1], /120363019502650977-group/);
    assert.equal(result.publication.destination, "120363019502650977-group");
});

test("migración y ruta mantienen persistencia, historial y autenticación", () => {
    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "0027_content_destinations.sql"), "utf8");
    const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "content-library.js"), "utf8");
    assert.match(migration, /CREATE TABLE IF NOT EXISTS content_destinations/);
    assert.match(migration, /UNIQUE \(tipo, external_id\)/);
    assert.match(migration, /'DESTINATION'/);
    assert.match(routes, /router\.post\("\/destinations\/whatsapp-groups", adminWriteLimiter, verificarToken/);
});
