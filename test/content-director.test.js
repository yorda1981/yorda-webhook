"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sources = require("../src/services/director/sources");
const director = require("../src/services/director/content-director");
const contentLibrary = require("../src/services/content-library");
const directorConfig = require("../src/services/director/director-config");
const CONFIG = { ...directorConfig.DEFAULT_CONFIG, mezcla: { ...directorConfig.DEFAULT_CONFIG.mezcla } };

const root = path.join(__dirname, "..");
const NOW = new Date("2026-10-12T12:00:00Z");
const APORTE = "Genera confianza: la familia sabe qué esperar y el cliente piensa en YORDA al enviar.";
const MANUAL = { version: "1", texto: "Una cotización vale 2 horas. La tarjeta tiene 16 dígitos. Con R$100 o más la tasa mejora." };
const SOURCE = { id: "cibercuba", nombre: "CiberCuba", rss: "https://example.test/rss", tipo: "medio" };
const ARTICLE_TEXT = "El Banco Central anunció que desde el 20 de octubre las tarjetas MLC tendrán un límite de 500 dólares por operación. ".repeat(4);

function rss(items) {
    return `<rss><channel>${items.map(i => `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link><pubDate>${i.date}</pubDate><description>${i.desc || ""}</description></item>`).join("")}</channel></rss>`;
}

// Pool falso: registra cada consulta y responde con `handler`.
function fakePool(handler = () => null) {
    const calls = [];
    let nextId = 100;
    const run = async (sql, params = []) => {
        const compact = String(sql).replace(/\s+/g, " ").trim();
        calls.push({ sql: compact, params });
        const custom = await handler(compact, params);
        if (custom) return custom;
        if (compact.startsWith("INSERT INTO director_runs")) return { rows: [{ id: 1 }] };
        if (compact.startsWith("INSERT INTO director_source_items")) return { rows: [{ id: nextId++ }] };
        return { rows: [] };
    };
    return { calls, query: run, connect: async () => ({ query: run, release() {} }) };
}

function fakeLibrary() {
    const drafts = [];
    return { drafts, createDirectorDraft: async (input) => { drafts.push(input); return { id: drafts.length }; } };
}

// Modelo falso: responde según la tarea y registra cada llamada.
function fakeLlm({ selection, news, permanent }) {
    const calls = [];
    return {
        calls,
        async completeJson(request) {
            calls.push(request);
            if (request.tarea === "seleccion") return { data: selection };
            if (request.system === director.NEWS_WRITING_SYSTEM) return { data: typeof news === "function" ? news(calls) : news };
            return { data: permanent };
        }
    };
}

const goodNews = {
    titulo: "Límite en tarjetas MLC",
    cuerpo: "*Nuevo límite en las tarjetas MLC*\n\nDesde el 20 de octubre, las tarjetas MLC tendrán un límite de 500 dólares por operación, según anunció el Banco Central.\n\n👉 Qué significa para ti: revisa el monto antes de enviar.\n\nFuente: CiberCuba",
    aporte: APORTE
};
const goodPermanent = {
    titulo: "Cómo funciona",
    cuerpo: "*Así funciona tu remesa*\n\n1. Escribe al bot el monto en reales.\n2. Envía una foto de la tarjeta o sus 16 dígitos.\n3. Paga el PIX y envía el comprobante.\n\nLa cotización vale 2 horas. Escríbenos por privado cuando quieras enviar.",
    aporte: APORTE
};

test("lee RSS con CDATA y entidades, y descarta items sin enlace", () => {
    const items = sources.parseRss(rss([
        { title: "Apagones &amp; tarifas", link: "https://a.test/1", date: "Mon, 12 Oct 2026 10:00:00 +0000", desc: "<p>Texto &quot;x&quot;</p>" },
        { title: "Sin enlace", link: "", date: "Mon, 12 Oct 2026 10:00:00 +0000" }
    ]), SOURCE);
    assert.equal(items.length, 1);
    assert.equal(items[0].titulo, "Apagones & tarifas");
    assert.equal(items[0].extracto, "Texto \"x\"");
    assert.equal(items[0].publicadoAt.toISOString(), "2026-10-12T10:00:00.000Z");
});

test("extrae el texto del artículo: articleBody, luego <article>, luego párrafos", () => {
    const body = "Texto completo de la noticia. ".repeat(10);
    assert.match(sources.extractArticleText(`<script type="application/ld+json">{"articleBody":"${body}"}</script>`), /Texto completo/);
    const para = "Este es un párrafo largo con información relevante para la comunidad cubana. ";
    const html = `<nav><p>${"Menú de navegación del sitio con muchos enlaces y secciones. ".repeat(2)}</p></nav><article><p>${para.repeat(3)}</p><p>${para.repeat(3)}</p></article>`;
    const text = sources.extractArticleText(html);
    assert.match(text, /párrafo largo/);
    assert.doesNotMatch(text, /Menú de navegación/);
});

test("una noticia con cifras inventadas, sin fuente citada o que menciona a YORDA se rechaza", () => {
    const story = { textos: [{ fuenteNombre: "CiberCuba", titulo: "MLC", texto: ARTICLE_TEXT }] };
    assert.equal(director.verifyNewsDraft(goodNews, story).ok, true);
    const invented = director.verifyNewsDraft({ ...goodNews, cuerpo: goodNews.cuerpo.replace("500", "750") }, story);
    assert.match(invented.errors.join(" "), /750/);
    const noSource = director.verifyNewsDraft({ ...goodNews, cuerpo: goodNews.cuerpo.replace("Fuente: CiberCuba", "") }, story);
    assert.match(noSource.errors.join(" "), /Fuente/);
    const yorda = director.verifyNewsDraft({ ...goodNews, cuerpo: `${goodNews.cuerpo} YORDA te ayuda.` }, story);
    assert.match(yorda.errors.join(" "), /YORDA/);
});

test("regla principal: sin aporte comercial el borrador no existe", () => {
    const story = { textos: [{ fuenteNombre: "CiberCuba", titulo: "MLC", texto: ARTICLE_TEXT }] };
    assert.match(director.verifyNewsDraft({ ...goodNews, aporte: "" }, story).errors.join(" "), /confianza, clientes o remesas/);
    assert.match(director.verifyPermanentDraft({ ...goodPermanent, aporte: "corto" }, MANUAL).errors.join(" "), /confianza, clientes o remesas/);
});

test("el contenido permanente solo puede usar cifras del Manual del proceso", () => {
    assert.equal(director.verifyPermanentDraft(goodPermanent, MANUAL).ok, true);
    const withPrice = director.verifyPermanentDraft({ ...goodPermanent, cuerpo: `${goodPermanent.cuerpo} Hoy pagas 450 CUP por real.` }, MANUAL);
    assert.match(withPrice.errors.join(" "), /450/);
});

test("la evaluación descarta ids inválidos, categorías desconocidas y candidatos sin aporte; agrupa noticias", async () => {
    const news = [1, 2, 3, 4].map(n => ({ id: n, titulo: `Noticia ${n}`, fuenteNombre: "CiberCuba", publicadoAt: NOW }));
    const top = { cercania: 3, objecion: 2, confianza: 2, alcance: 2, oportunidad: 3 };
    const llm = fakeLlm({ selection: { evaluaciones: [
        { id: "N1", agrupa: ["N2", "N9"], categoria: "bancos", puntuaciones: top, aporte: APORTE },
        { id: "N2", categoria: "bancos", puntuaciones: top, aporte: APORTE },        // ya agrupada en N1
        { id: "N3", categoria: "farandula", puntuaciones: top, aporte: APORTE },
        { id: "N4", categoria: "vuelos", puntuaciones: top, aporte: "" },
        { id: "P1", puntuaciones: { cercania: 9, objecion: -2 }, aporte: APORTE },
        { id: "P99", puntuaciones: top, aporte: APORTE }
    ] } });
    const ranked = await director.evaluateCandidates(news, ["como-funciona"], llm);
    assert.equal(ranked.length, 2);
    assert.deepEqual(ranked[0].items.map(item => item.id), [1, 2]);
    assert.equal(ranked[1].tipo, "permanente");
    assert.deepEqual(ranked[1].impacto.dimensiones, { cercania: 3, objecion: 0, confianza: 0, alcance: 0, oportunidad: 0 });
    assert.match(llm.calls[0].system, /NO es elegir las noticias más importantes/);
    assert.match(llm.calls[0].user, /TEMAS PERMANENTES:\nP1\. Cómo funciona/);
});

test("los temas permanentes rotan: primero los nunca usados y nunca uno usado en los últimos 21 días", async () => {
    const used = new Date(NOW.getTime() - 5 * 864e5);
    const old = new Date(NOW.getTime() - 40 * 864e5);
    const db = fakePool(sql => (sql.startsWith("SELECT categoria, MAX(creado_at)")
        ? { rows: Object.keys(director.PERMANENT_TOPICS).map((key, i) => ({ categoria: key, ultimo: i === 0 ? used : old })) }
        : null));
    const topics = await director.nextPermanentTopics(db, 2, NOW);
    assert.equal(topics.length, 2);
    assert.ok(!topics.includes(Object.keys(director.PERMANENT_TOPICS)[0]));
});

test("un borrador del Director sin grupo o sin aporte no se guarda", async () => {
    const db = { connect: async () => assert.fail("no debe escribir") };
    const base = { titulo: "T", cuerpo: "Cuerpo", fuentes: [{ nombre: "X", url: "https://x.test" }] };
    await assert.rejects(contentLibrary.createDirectorDraft({ ...base, aporte: APORTE }, db), { code: "CONTENT_LIBRARY_VALIDATION" });
    await assert.rejects(contentLibrary.createDirectorDraft({ ...base, grupo: "actualidad", aporte: "" }, db), { code: "CONTENT_LIBRARY_VALIDATION" });
});

test("el Manual del proceso existe, tiene versión y no contiene tasas", () => {
    const manual = director.loadManual();
    assert.ok(manual && manual.texto.length > 1000);
    assert.match(manual.version, /^\d+/);
    assert.doesNotMatch(manual.texto, /\d+\s*CUP por real|tasa de \d/i);
});

test("migración, rutas protegidas y arranque tras el esquema", () => {
    const migration = fs.readFileSync(path.join(root, "migrations", "0030_director_drafts.sql"), "utf8");
    assert.match(migration, /'ACTIVO', 'INACTIVO', 'BORRADOR'/);
    assert.match(migration, /grupo IN \('actualidad', 'permanente'\)/);
    assert.match(migration, /url\s+TEXT\s+NOT NULL UNIQUE/);
    const routes = fs.readFileSync(path.join(root, "src", "routes", "content-library.js"), "utf8");
    assert.match(routes, /router\.get\("\/director\/status", adminReadLimiter, verificarToken/);
    assert.match(routes, /router\.post\("\/director\/run", adminWriteLimiter, verificarToken/);
    assert.match(routes, /router\.post\("\/:id\/approve", adminWriteLimiter, verificarToken/);
    assert.match(routes, /router\.post\("\/:id\/discard", adminWriteLimiter, verificarToken/);
    assert.match(routes, /router\.post\("\/director\/config", adminWriteLimiter, verificarToken/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS director_config/);
    assert.match(migration, /"actualidad": 45, "educacion": 40, "confianza": 15/);
    const index = fs.readFileSync(path.join(root, "index.js"), "utf8");
    assert.match(index, /communityPulse\.startCommunityPulse\(\);\s*contentDirector\.startContentDirector\(\);/);
});

test("elimina las frases promocionales de los medios del texto extraído", () => {
    const para = "Recibir más noticias de CiberCuba en Google A las 20:00 el mercado informal cierra con el dólar al alza respecto a la jornada anterior.";
    const text = sources.extractArticleText(`<article><p>${para}</p><p>${para}</p></article>`);
    assert.doesNotMatch(text, /Recibir más noticias/);
    assert.match(text, /^A las 20:00/);
});


const rssWith = titles => async (url) => (url === SOURCE.rss
    ? rss(titles.map((title, n) => ({ title, link: `https://a.test/${n + 1}`, date: "Mon, 12 Oct 2026 08:00:00 +0000" })))
    : `<article><p>${ARTICLE_TEXT}</p></article>`);
const historyPool = rows => fakePool(sql => (sql.startsWith("SELECT ci.grupo, ci.categoria, cp.publicada_at") ? { rows } : null));
const published = (grupo, categoria, days) => ({ grupo, categoria, publicada_at: new Date(NOW.getTime() - days * 864e5) });

test("una noticia con impacto comercial alto se redacta con sus fuentes; lo que no llega al umbral no existe", async () => {
    const db = fakePool();
    const library = fakeLibrary();
    const llm = fakeLlm({
        selection: { evaluaciones: [
            { id: "N1", categoria: "bancos", puntuaciones: { cercania: 3, objecion: 1, confianza: 2, alcance: 3, oportunidad: 3 }, aporte: APORTE },
            { id: "P1", puntuaciones: { cercania: 2, objecion: 1, confianza: 1, alcance: 1, oportunidad: 0 }, aporte: APORTE }
        ] },
        news: goodNews,
        permanent: goodPermanent
    });
    const result = await director.runDirector({}, { pool: db, llm, library, now: NOW, config: CONFIG, manual: MANUAL, sources: [SOURCE], fetchText: rssWith(["Límite MLC"]) });
    assert.equal(result.estado, "COMPLETADO");
    assert.deepEqual({ actualidad: result.actualidad, permanentes: result.permanentes }, { actualidad: 1, permanentes: 0 });
    assert.equal(library.drafts[0].fuentes[0].url, "https://a.test/1");
    assert.equal(library.drafts[0].impacto.total, 78);
    assert.equal(result.detalle.ranking[1].resultado, "BAJO_UMBRAL");
    assert.equal(result.detalle.explicacion, undefined);
    assert.ok(db.calls.some(c => c.sql.startsWith("UPDATE director_source_items") && c.params[1] === "USADO"));
});

test("sin mínimo obligatorio: si nada vale la atención de la comunidad, no hay borradores y se explica por qué", async () => {
    const library = fakeLibrary();
    const llm = fakeLlm({ selection: { evaluaciones: [
        { id: "N1", categoria: "noticias", puntuaciones: { cercania: 1, objecion: 0, confianza: 1, alcance: 2, oportunidad: 2 }, aporte: APORTE },
        { id: "P1", puntuaciones: { cercania: 2, objecion: 1, confianza: 1, alcance: 1, oportunidad: 0 }, aporte: APORTE }
    ] }, permanent: goodPermanent });
    const result = await director.runDirector({}, { pool: fakePool(), llm, library, now: NOW, config: CONFIG, manual: MANUAL, sources: [SOURCE], fetchText: rssWith(["Farándula"]) });
    assert.equal(result.borradores, 0);
    assert.equal(library.drafts.length, 0);
    assert.match(result.detalle.explicacion, /ningún candidato valió la atención de la comunidad \(umbral 55\)/);
    assert.match(result.detalle.explicacion, /Cómo funciona una remesa con YORDA.*\(41\)/);
});

test("si la evaluación falla no se rellena: cero borradores con el motivo", async () => {
    const llm = { async completeJson(request) {
        if (request.tarea === "seleccion") throw new Error("modelo caído");
        return { data: goodPermanent };
    } };
    const result = await director.runDirector({}, { pool: fakePool(), llm, library: fakeLibrary(), now: NOW, config: CONFIG, manual: MANUAL, sources: [SOURCE], fetchText: async () => rss([]) });
    assert.equal(result.estado, "COMPLETADO");
    assert.equal(result.borradores, 0);
    assert.match(result.detalle.explicacion, /la evaluación falló \(modelo caído\)/);
});

test("una noticia que sigue inventando cifras tras el reintento se descarta y gana el siguiente candidato", async () => {
    const library = fakeLibrary();
    const llm = fakeLlm({
        selection: { evaluaciones: [
            { id: "N1", categoria: "bancos", puntuaciones: { cercania: 3, objecion: 3, confianza: 3, alcance: 3, oportunidad: 3 }, aporte: APORTE },
            { id: "P1", puntuaciones: { cercania: 3, objecion: 3, confianza: 2, alcance: 2, oportunidad: 1 }, aporte: APORTE }
        ] },
        news: { ...goodNews, cuerpo: goodNews.cuerpo.replace("500", "999") },
        permanent: goodPermanent
    });
    const result = await director.runDirector({}, { pool: fakePool(), llm, library, now: NOW, config: CONFIG, manual: MANUAL, sources: [SOURCE], fetchText: rssWith(["Límite MLC"]) });
    assert.equal(result.descartados, 1);
    assert.match(result.detalle.rechazos[0].errores.join(" "), /999/);
    assert.equal(llm.calls.filter(c => c.system === director.NEWS_WRITING_SYSTEM).length, 2);
    assert.match(llm.calls.filter(c => c.system === director.NEWS_WRITING_SYSTEM)[1].user, /se rechazó por/);
    assert.equal(result.permanentes, 1);
    assert.equal(result.detalle.ranking[0].resultado, "RECHAZADO");
});

test("criterio comercial: una noticia muy importante sin impacto en el negocio pierde frente a una guía", async () => {
    const llm = fakeLlm({
        selection: { evaluaciones: [
            { id: "N1", categoria: "noticias", puntuaciones: { cercania: 0, objecion: 0, confianza: 1, alcance: 3, oportunidad: 3 }, aporte: APORTE },
            { id: "P1", puntuaciones: { cercania: 3, objecion: 3, confianza: 2, alcance: 2, oportunidad: 1 }, aporte: APORTE }
        ] },
        news: goodNews,
        permanent: goodPermanent
    });
    const result = await director.runDirector({}, { pool: fakePool(), llm, library: fakeLibrary(), now: NOW, config: CONFIG, manual: MANUAL, sources: [SOURCE], fetchText: rssWith(["Visita oficial"]) });
    assert.deepEqual({ actualidad: result.actualidad, permanentes: result.permanentes }, { actualidad: 0, permanentes: 1 });
    assert.deepEqual(result.detalle.ranking.map(c => [c.tipo, c.impacto, c.resultado]), [["permanente", 81, "BORRADOR"], ["actualidad", 30, "BAJO_UMBRAL"]]);
});

test("memoria: tras días de tasas, una guía gana a una noticia de tasas ligeramente superior", async () => {
    const tasasHistory = [1, 2, 3, 4, 5, 6].map(d => published("actualidad", "tasas", d));
    const llm = fakeLlm({
        selection: { evaluaciones: [
            { id: "N1", categoria: "tasas", puntuaciones: { cercania: 2, objecion: 1, confianza: 2, alcance: 3, oportunidad: 3 }, aporte: APORTE },   // base 67
            { id: "P1", puntuaciones: { cercania: 3, objecion: 2, confianza: 1, alcance: 1, oportunidad: 0 }, aporte: APORTE }    // base 59
        ] },
        news: goodNews,
        permanent: goodPermanent
    });
    const result = await director.runDirector({}, { pool: historyPool(tasasHistory), llm, library: fakeLibrary(), now: NOW, config: CONFIG, manual: MANUAL, sources: [SOURCE], fetchText: rssWith(["Tasas hoy"]) });
    const [first, second] = result.detalle.ranking;
    assert.deepEqual([first.tipo, first.base, first.ajuste, first.impacto], ["permanente", 59, 15, 74]);
    assert.deepEqual([second.tipo, second.base, second.ajuste, second.impacto, second.resultado], ["actualidad", 67, -15, 52, "BAJO_UMBRAL"]);
    assert.match(second.motivos.join(" "), /100 % de lo publicado frente a 45 %/);
    assert.equal(result.permanentes, 1);
});

test("memoria: tras días educativos, la actualidad gana puntos; la urgencia real nunca se penaliza", () => {
    const candidate = (tipo, categoria, dims) => ({ tipo, categoria, impacto: director.impactOf(dims) });
    const educational = [1, 2, 3, 4].map(d => published("permanente", "pago", d));
    const news = director.balanceAdjustment(candidate("actualidad", "bancos", { cercania: 2 }), educational, CONFIG, NOW);
    assert.equal(news.ajuste, 15);
    const tasas = [1, 2, 3].map(d => published("actualidad", "tasas", d));
    const urgent = director.balanceAdjustment(candidate("actualidad", "tasas", { cercania: 3, oportunidad: 3 }), tasas, CONFIG, NOW);
    assert.equal(urgent.ajuste, 0);
    assert.match(urgent.motivos.join(" "), /urgente/);
    const tooLittle = director.balanceAdjustment(candidate("actualidad", "bancos", { cercania: 2 }), educational.slice(0, 2), CONFIG, NOW);
    assert.equal(tooLittle.ajuste, 0); // con menos de 3 publicaciones todavía no se equilibra
});

test("la mezcla sale de la configuración vigente, no del código", () => {
    const candidate = { tipo: "actualidad", categoria: "bancos", impacto: director.impactOf({ cercania: 2 }) };
    const history = [1, 2, 3, 4].map(d => published("actualidad", "economia", d));
    const allNews = { ...CONFIG, mezcla: { actualidad: 100, educacion: 0, confianza: 0 } };
    assert.equal(director.balanceAdjustment(candidate, history, allNews, NOW).ajuste, 0);
    assert.equal(director.balanceAdjustment(candidate, history, CONFIG, NOW).ajuste, -15);
});

test("una sola categoría por día", async () => {
    const top = { cercania: 3, objecion: 2, confianza: 2, alcance: 3, oportunidad: 3 };
    const result = await director.runDirector({}, {
        pool: fakePool(), library: fakeLibrary(), now: NOW, config: CONFIG, manual: MANUAL, sources: [SOURCE],
        llm: fakeLlm({ selection: { evaluaciones: [
            { id: "N1", categoria: "bancos", puntuaciones: top, aporte: APORTE },
            { id: "N2", categoria: "bancos", puntuaciones: top, aporte: APORTE }
        ] }, news: goodNews }),
        fetchText: rssWith(["Banco 1", "Banco 2"])
    });
    assert.equal(result.actualidad, 1);
    assert.equal(result.detalle.ranking[1].resultado, "NO_ELEGIDO");
});

test("las fuentes caídas no detienen al Director", async () => {
    const result = await director.runDirector({}, {
        pool: fakePool(), library: fakeLibrary(), now: NOW, config: CONFIG, manual: MANUAL, sources: [SOURCE],
        llm: fakeLlm({ selection: { evaluaciones: [{ id: "P1", puntuaciones: { cercania: 3, objecion: 3, confianza: 2, alcance: 2, oportunidad: 1 }, aporte: APORTE }] }, permanent: goodPermanent }),
        fetchText: async () => { throw new Error("timeout"); }
    });
    assert.equal(result.estado, "COMPLETADO");
    assert.match(result.detalle.fuentes.cibercuba.error, /timeout/);
    assert.equal(result.permanentes, 1);
});

test("aviso tras varios días seguidos sin borradores, sin rellenar", async () => {
    const db = fakePool(sql => {
        if (sql.startsWith("SELECT * FROM director_config")) return { rows: [] };
        if (sql.startsWith("SELECT fecha, SUM(borradores)")) return { rows: [{ borradores: 0 }, { borradores: 0 }, { borradores: 0 }, { borradores: 2 }] };
        return null;
    });
    const status = await director.getDirectorStatus(db);
    assert.equal(status.diasSinBorradores, 3);
    assert.match(status.alerta, /3 días sin generar borradores/);
    const fine = await director.getDirectorStatus(fakePool(sql => (sql.startsWith("SELECT fecha, SUM(borradores)") ? { rows: [{ borradores: 0 }, { borradores: 1 }] } : null)));
    assert.equal(fine.alerta, null);
});

test("la configuración se valida y cada cambio crea una versión con su motivo", async () => {
    assert.throws(() => directorConfig.normalizeConfig({ mezcla: { actualidad: 50 }, motivo: "Datos de octubre" }, CONFIG), /sumar 100/);
    assert.throws(() => directorConfig.normalizeConfig({ mezcla: { actualidad: 40, educacion: 45 }, motivo: "" }, CONFIG), /motivo/);
    assert.throws(() => directorConfig.normalizeConfig({ umbralImpacto: 120, motivo: "Prueba de límites" }, CONFIG), /umbralImpacto/);
    let insert;
    const db = { query: async (sql, params) => {
        if (sql.includes("SELECT * FROM director_config")) return { rows: [] };
        insert = params;
        return { rows: [{ id: "2", mezcla: JSON.parse(params[0]), umbral_impacto: params[1], max_borradores: params[2], ventana_dias: params[3], ajuste_maximo: params[4], penalizacion_repeticion: params[5], dias_alerta_sin_borradores: params[6], motivo: params[7], creado_por: "admin", creado_at: NOW }] };
    } };
    const saved = await directorConfig.saveConfig({ mezcla: { actualidad: 35, educacion: 50 }, motivo: "Las guías de pago generaron más cotizaciones en octubre" }, db);
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.mezcla, { actualidad: 35, educacion: 50, confianza: 15 });
    assert.equal(insert[7], "Las guías de pago generaron más cotizaciones en octubre");
});
