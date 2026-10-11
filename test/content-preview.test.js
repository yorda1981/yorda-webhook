"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { renderWhatsAppText, renderContentForChannel } = require("../src/services/content-renderer");
const { previewContentAsset } = require("../src/services/content-library");

test("preview aplica exactamente la transformación actual de WhatsApp", () => {
    const input = "  🔥 *TASAS YORDA*\n\nR$100: *valor vigente*  ";
    const result = previewContentAsset({ cuerpo: input });
    assert.deepEqual(result, {
        channel: "whatsapp_admin",
        destination: "ADMIN_PHONE",
        renderedBody: "🔥 TASAS YORDA\n\nR$100: valor vigente"
    });
    assert.equal(result.renderedBody, renderWhatsAppText(input));
});

test("render conserva saltos, emojis y enlaces; solo refleja transformaciones reales", () => {
    const input = "Hola 👋\nhttps://yorda.example/consulta\nLínea final";
    assert.equal(renderWhatsAppText(input), input);
});

test("el renderizador rechaza canales todavía fuera del alcance", () => {
    assert.throws(
        () => renderContentForChannel("mensaje", "instagram"),
        (error) => error.code === "CONTENT_CHANNEL_UNSUPPORTED"
    );
});

test("preview vacía reutiliza la validación de la Biblioteca", () => {
    assert.throws(
        () => previewContentAsset({ cuerpo: "  " }),
        (error) => error.code === "CONTENT_LIBRARY_VALIDATION"
    );
});

test("Z-API consume el mismo renderizador que la preview", () => {
    const zapi = fs.readFileSync(path.join(__dirname, "..", "src", "services", "zapi.js"), "utf8");
    assert.match(zapi, /require\("\.\/content-renderer"\)/);
    assert.match(zapi, /message: renderWhatsAppText\(message\)/);
    assert.doesNotMatch(zapi, /message:\s*String\(message\)\.replace/);
});

test("endpoint de preview es autenticado, limitado y read-only", () => {
    const routes = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "content-library.js"), "utf8");
    assert.match(routes, /router\.post\("\/preview", adminReadLimiter, verificarToken/);
    assert.match(routes, /service\.previewContentAsset/);
    assert.doesNotMatch(routes, /preview[\s\S]{0,250}(INSERT|UPDATE|DELETE)/);
});

test("interfaz solicita la preview al servidor y la muestra como texto seguro", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "content-center.html"), "utf8");
    assert.match(html, /Vista exacta en WhatsApp administrativo/);
    assert.match(html, /fetch\("\/admin\/content-library\/preview"/);
    assert.match(html, /previewBody"\)\.textContent = data\.preview\.renderedBody/);
    assert.doesNotMatch(html, /previewBody"\)\.innerHTML/);
});
