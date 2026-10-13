"use strict";

// Catálogo cerrado de fuentes del Director IA. Solo se lee de aquí: el
// sistema nunca busca en internet por su cuenta. Se combinan líneas
// editoriales distintas (independientes y oficial) para poder contrastar.
const axios = require("axios");

const SOURCES = Object.freeze([
    { id: "cibercuba", nombre: "CiberCuba", rss: "https://www.cibercuba.com/rss.xml", tipo: "medio" },
    { id: "14ymedio", nombre: "14ymedio", rss: "https://www.14ymedio.com/rss/", tipo: "medio" },
    { id: "oncuba", nombre: "OnCuba News", rss: "https://oncubanews.com/feed/", tipo: "medio" },
    { id: "diariodecuba", nombre: "Diario de Cuba", rss: "https://diariodecuba.com/rss.xml", tipo: "medio" },
    { id: "periodicocubano", nombre: "Periódico Cubano", rss: "https://www.periodicocubano.com/feed/", tipo: "medio" },
    { id: "granma", nombre: "Granma (oficial)", rss: "https://www.granma.cu/feed", tipo: "oficial" }
]);

const USER_AGENT = "Mozilla/5.0 (compatible; YordaDirector/1.0)";
const MAX_ARTICLE_CHARS = 12000;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

// Frases promocionales de los propios medios que se cuelan en el texto del artículo.
const BOILERPLATE = [
    /Recibir más noticias de [^.]{1,40}? en Google\s*/gi,
    /Síguenos en [^.]{1,60}?(\.|$)\s*/gi,
    /Únete a nuestro canal[^.]*(\.|$)\s*/gi
];

function stripBoilerplate(text) {
    return BOILERPLATE.reduce((result, pattern) => result.replace(pattern, ""), text).trim();
}

function decodeEntities(text) {
    return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
        if (code[0] === "#") {
            const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(value) ? String.fromCodePoint(value) : match;
        }
        return ENTITIES[code.toLowerCase()] ?? match;
    });
}

function cleanText(value) {
    return decodeEntities(String(value || "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
}

function tag(item, name) {
    const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
    return match ? match[1] : "";
}

// RSS 2.0 mínimo: título, enlace, fecha y extracto de cada <item>.
function parseRss(xml, source) {
    const items = String(xml || "").match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
    return items.map(item => {
        const published = new Date(cleanText(tag(item, "pubDate")));
        return {
            fuente: source.id,
            fuenteNombre: source.nombre,
            titulo: cleanText(tag(item, "title")),
            url: cleanText(tag(item, "link")),
            extracto: cleanText(tag(item, "description")).slice(0, 500),
            publicadoAt: Number.isNaN(published.getTime()) ? null : published
        };
    }).filter(item => item.titulo && /^https?:\/\//.test(item.url));
}

// Texto del artículo: primero articleBody de JSON-LD, después los párrafos
// de <article>, y como último recurso los párrafos largos de la página.
function extractArticleText(html) {
    const page = String(html || "");
    for (const script of page.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []) {
        const match = script.match(/"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (match) {
            try {
                const body = stripBoilerplate(cleanText(JSON.parse(`"${match[1]}"`)));
                if (body.length > 200) return body.slice(0, MAX_ARTICLE_CHARS);
            } catch (_) { /* JSON-LD mal formado: se prueba el siguiente método */ }
        }
    }
    const withoutNoise = page.replace(/<(script|style|nav|footer|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, " ");
    const paragraphs = scope => [...new Set((scope.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [])
        .map(text => stripBoilerplate(cleanText(text)))
        .filter(text => text.length > 60))];
    const article = withoutNoise.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    let found = article ? paragraphs(article[1]) : [];
    if (found.join(" ").length < 300) found = paragraphs(withoutNoise);
    return found.join("\n").slice(0, MAX_ARTICLE_CHARS);
}

async function fetchText(url, timeout = 15000) {
    const response = await axios.get(url, {
        timeout,
        responseType: "text",
        maxContentLength: 5 * 1024 * 1024,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xml;q=0.9,*/*;q=0.8" }
    });
    return String(response.data || "");
}

async function fetchSourceItems(source, dependencies = {}) {
    const fetch = dependencies.fetchText || fetchText;
    return parseRss(await fetch(source.rss), source);
}

async function fetchArticle(url, dependencies = {}) {
    const fetch = dependencies.fetchText || fetchText;
    return extractArticleText(await fetch(url));
}

module.exports = {
    SOURCES,
    decodeEntities,
    cleanText,
    parseRss,
    extractArticleText,
    fetchSourceItems,
    fetchArticle
};
