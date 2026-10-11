"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    PUBLICATION_STATES,
    isPublicationState,
    canTransitionPublication,
    assertPublicationTransition
} = require("../src/services/content-center-states");

const migrationPath = path.join(__dirname, "..", "migrations", "0024_content_center_core.sql");
const migration = fs.readFileSync(migrationPath, "utf8");

test("Content Center define identidades separadas para contenido, revisión, publicación e intento", () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS content_items/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS content_revisions/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS content_publications/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS content_publication_attempts/);
    assert.match(migration, /FOREIGN KEY \(revision_id, content_item_id\)[\s\S]*?REFERENCES content_revisions\(id, content_item_id\)/);
    assert.match(migration, /publication_id\s+BIGINT NOT NULL REFERENCES content_publications\(id\)/);
});

test("la revisión y la publicación conservan el cuerpo exacto sin depender del contenido editable", () => {
    assert.match(migration, /content_revisions[\s\S]*?cuerpo\s+TEXT NOT NULL/);
    assert.match(migration, /content_publications[\s\S]*?cuerpo_renderizado\s+TEXT NOT NULL/);
});

test("el destino de V1 queda limitado por defecto al WhatsApp administrativo", () => {
    assert.match(migration, /canal\s+VARCHAR\(40\) NOT NULL DEFAULT 'whatsapp_admin'/);
    assert.match(migration, /destino_ref\s+VARCHAR\(120\) NOT NULL DEFAULT 'ADMIN_PHONE'/);
});

test("la cola persistente puede localizar publicaciones vencidas sin recorrer toda la tabla", () => {
    assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_content_publications_due[\s\S]*?programada_para[\s\S]*?WHERE estado = 'PROGRAMADA'/);
    assert.match(migration, /idempotency_key\s+VARCHAR\(160\) NOT NULL UNIQUE/);
});

test("el historial estructurado conserva tipo, entidad, actor, momento y metadatos", () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS content_events/);
    for (const field of ["entity_type", "entity_id", "event_type", "actor", "datos", "ocurrido_at"]) {
        assert.match(migration, new RegExp(`\\b${field}\\b`));
    }
});

test("solo reconoce los seis estados operativos aprobados", () => {
    assert.deepEqual(Object.values(PUBLICATION_STATES), [
        "PROGRAMADA", "PUBLICANDO", "PUBLICADA", "FALLIDA", "AMBIGUA", "CANCELADA"
    ]);
    assert.equal(isPublicationState("PROGRAMADA"), true);
    assert.equal(isPublicationState("BORRADOR"), false);
    assert.equal(isPublicationState("INVENTADA"), false);
});

test("una publicación programada solo puede reclamarse o cancelarse", () => {
    assert.equal(canTransitionPublication("PROGRAMADA", "PUBLICANDO"), true);
    assert.equal(canTransitionPublication("PROGRAMADA", "CANCELADA"), true);
    assert.equal(canTransitionPublication("PROGRAMADA", "PUBLICADA"), false);
    assert.equal(canTransitionPublication("PROGRAMADA", "FALLIDA"), false);
});

test("publicando termina en publicada, fallida o ambigua", () => {
    assert.equal(canTransitionPublication("PUBLICANDO", "PUBLICADA"), true);
    assert.equal(canTransitionPublication("PUBLICANDO", "FALLIDA"), true);
    assert.equal(canTransitionPublication("PUBLICANDO", "AMBIGUA"), true);
    assert.equal(canTransitionPublication("PUBLICANDO", "CANCELADA"), false);
});

test("solo un fallo inequívoco admite reintento manual", () => {
    assert.equal(canTransitionPublication("FALLIDA", "PUBLICANDO"), true);
    assert.equal(canTransitionPublication("AMBIGUA", "PUBLICANDO"), false);
    assert.equal(canTransitionPublication("PUBLICADA", "PUBLICANDO"), false);
    assert.equal(canTransitionPublication("CANCELADA", "PUBLICANDO"), false);
});

test("una transición inválida falla con un código estable", () => {
    assert.throws(
        () => assertPublicationTransition("PUBLICADA", "PROGRAMADA"),
        (error) => error.code === "CONTENT_PUBLICATION_INVALID_TRANSITION"
    );
});
