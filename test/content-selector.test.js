"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { normalizeLanguage, selectContent } = require("../src/services/content-selector");

test("idioma por defecto es español y solo admite idiomas objetivos conocidos", () => {
    assert.equal(normalizeLanguage(), "es");
    assert.equal(normalizeLanguage(" PT "), "pt");
    assert.throws(
        () => normalizeLanguage("en"),
        (error) => error.code === "CONTENT_SELECTOR_VALIDATION"
    );
});

test("selector filtra activos por idioma y aplica un orden totalmente determinista", async () => {
    let captured;
    const db = { async query(sql, params) {
        captured = { sql: String(sql).replace(/\s+/g, " ").trim(), params };
        return { rows: [{
            id: "7", revision_id: "12", revision_numero: 3,
            titulo: "Confianza", cuerpo: "Contenido reutilizable",
            estado: "ACTIVO", idioma: "es", prioridad: 80,
            ultima_utilizacion_at: null
        }] };
    }};
    const selected = await selectContent({ idioma: "es" }, db);
    assert.deepEqual(captured.params, ["es"]);
    assert.match(captured.sql, /WHERE ci\.estado = 'ACTIVO' AND ci\.idioma = \$1/);
    assert.match(captured.sql, /ci\.prioridad DESC, ci\.ultima_utilizacion_at ASC NULLS FIRST, ci\.id ASC/);
    assert.equal(selected.contentId, 7);
    assert.equal(selected.revision, 3);
    assert.equal(selected.criterio, "PRIORIDAD_Y_MENOR_USO");
});

test("sin contenido elegible devuelve null y no inventa una alternativa", async () => {
    const db = { async query() { return { rows: [] }; } };
    assert.equal(await selectContent({ idioma: "pt" }, db), null);
});

test("motor usa siempre la revisión más reciente del activo seleccionado", async () => {
    let sql;
    const db = { async query(query) { sql = query; return { rows: [] }; } };
    await selectContent({}, db);
    assert.match(sql, /JOIN LATERAL[\s\S]*?FROM content_revisions[\s\S]*?ORDER BY numero DESC[\s\S]*?LIMIT 1/);
});

test("migración limita estado, idioma y prioridad con constraints e índice parcial", () => {
    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "0025_content_selection_metadata.sql"), "utf8");
    assert.match(migration, /estado IN \('ACTIVO', 'INACTIVO'\)/);
    assert.match(migration, /idioma IN \('es', 'pt'\)/);
    assert.match(migration, /prioridad BETWEEN 0 AND 100/);
    assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_content_items_selection/);
    assert.match(migration, /WHERE estado = 'ACTIVO'/);
});

test("endpoint de selección es autenticado, read-only y está antes de /:id", () => {
    const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "content-library.js"), "utf8");
    const selectionAt = routes.indexOf('router.get("/selection"');
    const idAt = routes.indexOf('router.get("/:id"');
    assert.ok(selectionAt >= 0 && selectionAt < idAt);
    assert.match(routes, /router\.get\("\/selection", adminReadLimiter, verificarToken/);
    assert.match(routes, /selector\.selectContent/);
});

test("motor no conoce canales, publicación, programación ni transporte", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "content-selector.js"), "utf8");
    assert.doesNotMatch(source, /zapi|whatsapp|telegram|ADMIN_PHONE|enviarMensaje|content_publications|programada_para/i);
    assert.doesNotMatch(source, /UPDATE|INSERT|DELETE/);
});

test("con contentId selecciona ese activo activo, sin filtrar por idioma", async () => {
    let captured;
    const db = { async query(sql, params) {
        captured = { sql: String(sql).replace(/\s+/g, " ").trim(), params };
        return { rows: [] };
    } };
    await selectContent({ idioma: "es", contentId: "10" }, db);
    assert.deepEqual(captured.params, [10]);
    assert.match(captured.sql, /WHERE ci\.estado = 'ACTIVO' AND ci\.id = \$1/);
    assert.doesNotMatch(captured.sql, /ci\.idioma = \$1/);
    await assert.rejects(selectContent({ contentId: "abc" }, db), { code: "CONTENT_SELECTOR_VALIDATION" });
});

test("selecciona borradores aprobados del Director por estado ACTIVO, nunca borradores ni inactivos", async () => {
    let sql;
    const db = { async query(query) {
        sql = query;
        return { rows: [{ id: 18, revision_id: 4, revision_numero: 2, titulo: "Guía", cuerpo: "Aprobada", estado: "ACTIVO", idioma: "es", prioridad: 50 }] };
    }};
    const result = await selectContent({ idioma: "es" }, db);
    assert.equal(result.contentId, 18);
    assert.match(sql, /ci\.estado = 'ACTIVO'/);
    assert.doesNotMatch(sql, /origen_sistema IS NULL/);
});
