"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    normalizeTitle,
    normalizeBody,
    normalizePagination,
    createContentAsset,
    updateContentAsset
} = require("../src/services/content-library");

function fakeTransactionalDb(handler) {
    const calls = [];
    const client = {
        async query(sql, params = []) {
            const compact = String(sql).replace(/\s+/g, " ").trim();
            calls.push({ sql: compact, params });
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(compact)) return { rows: [] };
            return handler(compact, params, calls);
        },
        release() { calls.push({ sql: "RELEASE", params: [] }); }
    };
    return { calls, async connect() { return client; } };
}

test("validación de biblioteca rechaza activos vacíos o excesivos", () => {
    assert.throws(() => normalizeTitle("  "), { code: "CONTENT_LIBRARY_VALIDATION" });
    assert.throws(() => normalizeTitle("x".repeat(161)), { code: "CONTENT_LIBRARY_VALIDATION" });
    assert.throws(() => normalizeBody("\n\t"), { code: "CONTENT_LIBRARY_VALIDATION" });
    assert.throws(() => normalizeBody("x".repeat(20001)), { code: "CONTENT_LIBRARY_VALIDATION" });
    assert.equal(normalizeTitle("  Activo YORDA  "), "Activo YORDA");
    assert.equal(normalizeBody("  Mensaje útil  "), "Mensaje útil");
});

test("paginación queda acotada y no acepta offsets negativos", () => {
    assert.deepEqual(normalizePagination({ limit: 500, offset: -2 }), { limit: 100, offset: 0 });
    assert.deepEqual(normalizePagination({ limit: 25, offset: 50 }), { limit: 25, offset: 50 });
});

test("crear activo guarda contenido, primera revisión y eventos en una transacción", async () => {
    const now = new Date().toISOString();
    const db = fakeTransactionalDb(async (sql) => {
        if (sql.startsWith("INSERT INTO content_items")) {
            return { rows: [{ id: "10", titulo: "Tasas con confianza", creado_at: now, actualizado_at: now }] };
        }
        if (sql.startsWith("INSERT INTO content_revisions")) {
            return { rows: [{ id: "20", numero: 1, cuerpo: "Consulta nuestras tasas." }] };
        }
        if (sql.startsWith("INSERT INTO content_events")) return { rows: [] };
        throw new Error(`SQL inesperado: ${sql}`);
    });

    const asset = await createContentAsset({
        titulo: " Tasas con confianza ",
        cuerpo: " Consulta nuestras tasas. "
    }, db);

    assert.equal(asset.id, 10);
    assert.equal(asset.revision, 1);
    assert.equal(asset.cuerpo, "Consulta nuestras tasas.");
    assert.deepEqual(db.calls.map((call) => call.sql === "RELEASE" ? "RELEASE" : call.sql.split(" ")[0]),
        ["BEGIN", "INSERT", "INSERT", "INSERT", "COMMIT", "RELEASE"]);
    const eventCall = db.calls.find((call) => call.sql.startsWith("INSERT INTO content_events"));
    assert.match(eventCall.sql, /CONTENT_ASSET_CREATED/);
    assert.match(eventCall.sql, /CONTENT_REVISION_CREATED/);
});

test("editar el cuerpo crea una revisión nueva sin sobrescribir la anterior", async () => {
    const now = new Date().toISOString();
    const db = fakeTransactionalDb(async (sql, params) => {
        if (sql.startsWith("SELECT ci.id")) return { rows: [{
            id: "10", titulo: "Activo", cuerpo: "Versión original", revision_id: "20",
            revision_numero: 1, creado_at: now, actualizado_at: now
        }] };
        if (sql.startsWith("UPDATE content_items")) return { rows: [{
            id: "10", titulo: params[1], creado_at: now, actualizado_at: now
        }] };
        if (sql.startsWith("INSERT INTO content_revisions")) {
            return { rows: [{ id: "21", numero: 2, cuerpo: params[2] }] };
        }
        if (sql.startsWith("INSERT INTO content_events")) return { rows: [] };
        throw new Error(`SQL inesperado: ${sql}`);
    });

    const asset = await updateContentAsset(10, { titulo: "Activo", cuerpo: "Versión mejorada" }, db);
    assert.equal(asset.revision, 2);
    assert.equal(asset.revisionId, 21);
    assert.equal(asset.cuerpo, "Versión mejorada");
    assert.equal(db.calls.filter((call) => call.sql.startsWith("INSERT INTO content_revisions")).length, 1);
    assert.match(db.calls.find((call) => call.sql.startsWith("SELECT ci.id")).sql, /FOR UPDATE OF ci/);
});

test("guardar sin cambios no crea revisión ni evento artificial", async () => {
    const now = new Date().toISOString();
    const db = fakeTransactionalDb(async (sql) => {
        if (sql.startsWith("SELECT ci.id")) return { rows: [{
            id: "10", titulo: "Activo", cuerpo: "Mismo texto", revision_id: "20",
            revision_numero: 3, creado_at: now, actualizado_at: now
        }] };
        throw new Error(`SQL inesperado: ${sql}`);
    });
    const asset = await updateContentAsset(10, { titulo: "Activo", cuerpo: "Mismo texto" }, db);
    assert.equal(asset.revision, 3);
    assert.equal(db.calls.some((call) => call.sql.startsWith("INSERT")), false);
    assert.equal(db.calls.some((call) => call.sql.startsWith("UPDATE")), false);
});

test("activo inexistente devuelve null y cierra la transacción sin escribir", async () => {
    const db = fakeTransactionalDb(async (sql) => {
        if (sql.startsWith("SELECT ci.id")) return { rows: [] };
        throw new Error(`SQL inesperado: ${sql}`);
    });
    const result = await updateContentAsset(999, { titulo: "Activo", cuerpo: "Contenido" }, db);
    assert.equal(result, null);
    assert.equal(db.calls.some((call) => call.sql === "ROLLBACK"), true);
    assert.equal(db.calls.some((call) => call.sql.startsWith("INSERT")), false);
});

test("rutas de biblioteca usan límites y autenticación administrativos", () => {
    const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "content-library.js"), "utf8");
    assert.match(routes, /router\.get\("\/", adminReadLimiter, verificarToken/);
    assert.match(routes, /router\.post\("\/", adminWriteLimiter, verificarToken/);
    assert.match(routes, /router\.post\("\/:id", adminWriteLimiter, verificarToken/);
    assert.doesNotMatch(routes, /publicar|programar|enviarMensaje|zapi/i);
});

test("la interfaz presenta una biblioteca de activos sin adelantar funciones futuras", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "content-center.html"), "utf8");
    assert.match(html, /Biblioteca de Contenido/);
    assert.match(html, /Activos de contenido/);
    assert.match(html, /Guardar en la biblioteca/);
    assert.match(html, /Cada guardado conserva una revisión/);
    assert.doesNotMatch(html, /Publicar ahora|Programar publicación|Audiencia|Campaña|Plantilla/);
});

test("index registra la API modular y la página independiente", () => {
    const index = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    const dashboard = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    assert.match(index, /app\.use\("\/admin\/content-library", createContentLibraryRouter\(\)\)/);
    assert.match(index, /app\.get\("\/content-center"/);
    assert.match(index, /public", "content-center\.html"/);
    assert.match(dashboard, /href="\/content-center"[^>]*>📚 Biblioteca de Contenido/);
});
