"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const destinations = require("../src/services/content-destinations");
const adapters = require("../src/services/content-output-adapters");
const { preparePublication, publishSelectedContent } = require("../src/services/content-publisher");

test("registrar un grupo lo convierte en el único destino activo, en una transacción", async () => {
    const calls = [];
    const client = {
        async query(sql, params = []) {
            const compact = String(sql).replace(/\s+/g, " ").trim();
            calls.push({ sql: compact, params });
            if (compact.includes("CONTENT_DESTINATION_VALIDATED")) {
                return { rows: [{ id: "7", tipo: "WHATSAPP_GROUP", external_id: params[1], nombre: params[2], activo: true, validado_at: "2026-10-11" }] };
            }
            return { rows: [] };
        },
        release() { calls.push({ sql: "RELEASE" }); }
    };
    const destination = await destinations.registerWhatsAppGroup(
        { groupId: "120363019502650977-group" },
        {
            validateGroup: async () => ({
                phone: "120363019502650977-group",
                subject: "Clientes YORDA",
                participants: [{ phone: "5511999999999", isAdmin: false }]
            }),
            getDevice: async () => ({ phone: "5511999999999" }),
            pool: { connect: async () => client }
        }
    );
    assert.equal(destination.destinationId, 7);
    assert.equal(destination.externalId, "120363019502650977-group");
    const sqls = calls.map((call) => call.sql);
    assert.equal(sqls[0], "BEGIN");
    assert.match(sqls[1], /LOCK TABLE content_destinations/);
    assert.match(sqls[2], /SET activo = FALSE[\s\S]*NOT \(tipo = \$1 AND external_id = \$2\)[\s\S]*CONTENT_DESTINATION_DEACTIVATED/);
    assert.match(sqls[3], /CONTENT_DESTINATION_VALIDATED/);
    assert.deepEqual(sqls.slice(4), ["COMMIT", "RELEASE"]);
});

test("si falla el registro no queda ningún destino desactivado a medias", async () => {
    const calls = [];
    const client = {
        async query(sql) {
            const compact = String(sql).replace(/\s+/g, " ").trim();
            calls.push(compact);
            if (compact.includes("CONTENT_DESTINATION_VALIDATED")) throw new Error("fallo de escritura");
            return { rows: [] };
        },
        release() {}
    };
    await assert.rejects(destinations.registerWhatsAppGroup(
        { groupId: "120363019502650977-group" },
        {
            validateGroup: async () => ({ phone: "120363019502650977-group", subject: "G", participants: [{ phone: "5511999999999" }] }),
            getDevice: async () => ({ phone: "5511999999999" }),
            pool: { connect: async () => client }
        }
    ), /fallo de escritura/);
    assert.equal(calls.at(-1), "ROLLBACK");
});

test("sin destino explícito, el adaptador usa el destino activo del Motor", async () => {
    const destination = await adapters.resolveOutputDestination(
        { idioma: "es" },
        { adminPhone: "5511999999999", getDefaultDestination: async () => ({ type: "WHATSAPP_GROUP", externalId: "120363019502650977-group" }) }
    );
    assert.deepEqual(destination, {
        type: "WHATSAPP_GROUP", channel: "whatsapp_group",
        reference: "120363019502650977-group", address: "120363019502650977-group"
    });
});

test("sin destino activo no hay destino: nunca se redirige al WhatsApp administrativo", async () => {
    const destination = await adapters.resolveOutputDestination(
        {},
        { adminPhone: "5511999999999", getDefaultDestination: async () => null }
    );
    assert.equal(destination, null);
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "content-output-adapters.js"), "utf8");
    assert.doesNotMatch(source, /getAdminPhone|ADMIN_PHONE|whatsapp_admin/);
});

test("publicar sin destino activo no envía ni crea la publicación", async () => {
    const result = await publishSelectedContent(
        { idempotencyKey: "library-10-now", contentId: 10 },
        {
            pool: {},
            selector: { normalizeLanguage: (value) => value || "es" },
            getDefaultDestination: async () => null,
            prepareFn: async () => assert.fail("no debe registrar la publicación"),
            sendDestinationFn: async () => assert.fail("no debe enviar")
        }
    );
    assert.equal(result.code, "DESTINATION_NOT_FOUND");
});

test("rechaza un grupo que el proveedor no puede validar", async () => {
    await assert.rejects(
        destinations.registerWhatsAppGroup(
            { groupId: "120363019502650977-group" },
            { validateGroup: async () => null, getDevice: async () => ({ phone: "5511999999999" }), pool: { query: async () => assert.fail("no debe persistir") } }
        ),
        { code: "CONTENT_DESTINATION_VALIDATION" }
    );
});

const noPersist = { query: async () => assert.fail("no debe persistir") };

test("rechaza un grupo donde el bot no es participante", async () => {
    await assert.rejects(
        destinations.registerWhatsAppGroup(
            { groupId: "120363019502650977-group" },
            {
                validateGroup: async () => ({ phone: "120363019502650977-group", subject: "Otro", participants: [{ phone: "5511888888888" }] }),
                getDevice: async () => ({ phone: "5511999999999" }),
                pool: noPersist
            }
        ),
        { code: "CONTENT_DESTINATION_VALIDATION", message: /no es participante/ }
    );
});

test("rechaza un grupo de solo administradores si el bot no es admin", async () => {
    await assert.rejects(
        destinations.registerWhatsAppGroup(
            { groupId: "120363019502650977-group" },
            {
                validateGroup: async () => ({ phone: "120363019502650977-group", subject: "Avisos", adminOnlyMessage: true, participants: [{ phone: "5511999999999", isAdmin: false }] }),
                getDevice: async () => ({ phone: "5511999999999" }),
                pool: noPersist
            }
        ),
        { code: "CONTENT_DESTINATION_VALIDATION", message: /administradores/ }
    );
});

test("si no se puede identificar el número del bot es error del proveedor, no del grupo", async () => {
    await assert.rejects(
        destinations.registerWhatsAppGroup(
            { groupId: "120363019502650977-group" },
            { validateGroup: async () => ({ phone: "120363019502650977-group" }), getDevice: async () => null, pool: noPersist }
        ),
        { code: "CONTENT_DESTINATION_PROVIDER" }
    );
});

test("normaliza el JID @g.us al formato de Z-API y rechaza números de contacto", () => {
    assert.equal(destinations.normalizeGroupId("120363019502650977@g.us"), "120363019502650977-group");
    assert.equal(destinations.normalizeGroupId("5511999999999-1623281429"), "5511999999999-1623281429");
    assert.throws(() => destinations.normalizeGroupId("5511999999999"), { code: "CONTENT_DESTINATION_VALIDATION" });
});

test("descubre grupos paginando Z-API y los cruza con destinos registrados", async () => {
    const pages = [];
    const firstPage = Array.from({ length: 100 }, (_, i) => ({ isGroup: true, name: `Grupo ${i}`, phone: `1203630000000${String(i).padStart(3, "0")}-group` }));
    const groups = await destinations.discoverWhatsAppGroups({
        listGroups: async ({ page, pageSize }) => {
            pages.push({ page, pageSize });
            return page === 1 ? firstPage : [
                { isGroup: true, name: "Remesas nacional e internacional 🏦", phone: "120363019502650977-group" },
                { isGroup: false, name: "Contacto", phone: "5511999999999" }
            ];
        },
        pool: { query: async () => ({ rows: [{ id: "7", tipo: "WHATSAPP_GROUP", external_id: "120363019502650977-group", nombre: "Remesas", activo: true, validado_at: "2026-10-11" }] }) }
    });
    assert.deepEqual(pages.map(p => p.page), [1, 2]);
    assert.equal(groups.length, 101);
    const remesas = groups.find(g => g.groupId === "120363019502650977-group");
    assert.equal(remesas.name, "Remesas nacional e internacional 🏦");
    assert.equal(remesas.destinationId, 7);
    assert.equal(remesas.active, true);
    assert.equal(groups.find(g => g.groupId !== remesas.groupId).registered, false);
});

test("descubrimiento falla de forma explícita si Z-API no responde", async () => {
    await assert.rejects(
        destinations.discoverWhatsAppGroups({ listGroups: async () => null, pool: noPersist }),
        { code: "CONTENT_DESTINATION_PROVIDER" }
    );
});

test("desactivar un destino registra el evento", async () => {
    let query;
    const destination = await destinations.deactivateDestination("7", {
        query: async (sql, params) => {
            query = { sql, params };
            return { rows: [{ id: "7", tipo: "WHATSAPP_GROUP", external_id: "120363019502650977-group", nombre: "Remesas", activo: false, validado_at: "2026-10-11" }] };
        }
    });
    assert.equal(destination.active, false);
    assert.deepEqual(query.params, [7]);
    assert.match(query.sql, /CONTENT_DESTINATION_DEACTIVATED/);
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
    assert.match(routes, /router\.get\("\/destinations\/whatsapp-groups\/available", adminReadLimiter, verificarToken/);
    assert.match(routes, /router\.post\("\/destinations\/:id\/deactivate", adminWriteLimiter, verificarToken/);
    assert.ok(routes.indexOf('"/destinations"') < routes.indexOf('router.get("/:id"'), "las rutas de destinos deben ir antes de /:id");
});
