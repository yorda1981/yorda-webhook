"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — motor de mensajes de recuperación (PREVIEW, sin
// envío) -- src/services/recuperacion-mensajes.js +
// GET /admin/recuperacion/mensaje (index.js).
//
// Estructura: funciones puras con rng inyectable (nunca Math.random()
// directo en los tests) -- ver rngSecuencia() abajo, mismo criterio que el
// resto del proyecto para hacer determinista lo que normalmente es
// aleatorio (pick()/pickL() en shared.js).
// ─────────────────────────────────────────────────────────

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pool = require("../db");
const recuperacionMensajes = require("../src/services/recuperacion-mensajes");
const recuperacionService = require("../src/services/recuperacion");
const {
    fraseServicio, antiguedadTono, familiasElegibles, totalOpciones,
    elegirFamiliaVariante, renderizarMensaje, generarMensajePreview, FAMILIAS
} = recuperacionMensajes;

function rngSecuencia(valores) {
    let i = 0;
    return () => valores[i++ % valores.length];
}

function horasAtras(h) { return new Date(Date.now() - h * 3600000).toISOString(); }

const CANDIDATO_BASE = {
    phone: "5511900040001", nombre: "Lourdes Abreu", ultimoMonto: 918273,
    fechaIntento: horasAtras(50) // 1-3d
};

// ── Nombre confiable ──

test("nombre confiable ('Lourdes Abreu') -> se usa el primer nombre en el mensaje", () => {
    const c = { ...CANDIDATO_BASE, tipoFavorito: "brl_cup" };
    const rng = rngSecuencia([0, 0]); // primera familia/variante elegible
    const p = generarMensajePreview(c, { rng });
    assert.match(p.mensaje, /Lourdes/);
});

test("sin nombre confiable (placeholder 'Cliente') -> nunca inventa un nombre", () => {
    const c = { ...CANDIDATO_BASE, nombre: "Cliente", tipoFavorito: "brl_cup" };
    for (const familia of Object.keys(FAMILIAS)) {
        for (let indice = 0; indice < FAMILIAS[familia].variantes.length; indice++) {
            const msg = renderizarMensaje(c, { familia, indice });
            assert.doesNotMatch(msg, /\bCliente\b/, `familia=${familia} indice=${indice} no debe decir "Cliente"`);
        }
    }
});

test("sin nombre en absoluto (null) -> nunca inventa un nombre", () => {
    const c = { ...CANDIDATO_BASE, nombre: null, tipoFavorito: "mlc" };
    for (const familia of Object.keys(FAMILIAS)) {
        for (let indice = 0; indice < FAMILIAS[familia].variantes.length; indice++) {
            const msg = renderizarMensaje(c, { familia, indice });
            assert.doesNotMatch(msg, /undefined|null/i);
        }
    }
});

// BUG REAL (producción): un candidato tenía un email guardado como
// "nombre" -- con el filtro anterior, el preview lo interpolaba tal cual
// ("livanperezma@gmail.com, ..."). Ahora primerNombreConfiable() lo
// rechaza (ver reglas-bot.js) y el mensaje sale natural, sin el email.
test("preview con nombre=email -> mensaje natural, SIN el nombre/email filtrado", () => {
    const c = { ...CANDIDATO_BASE, nombre: "livanperezma@gmail.com", tipoFavorito: "brl_cup" };
    for (const familia of Object.keys(FAMILIAS)) {
        for (let indice = 0; indice < FAMILIAS[familia].variantes.length; indice++) {
            const msg = renderizarMensaje(c, { familia, indice });
            assert.doesNotMatch(msg, /@/, `familia=${familia} indice=${indice} no debe filtrar el email`);
            assert.doesNotMatch(msg, /livanperezma/i);
        }
    }
});

// ── Compatibilidad de servicio: MLC / USD / CUP / efectivo / recarga ──

test("fraseServicio: mapeo exacto para cada tipo_favorito", () => {
    assert.equal(fraseServicio("mlc"), "un envío en MLC");
    assert.equal(fraseServicio("usd_clasica"), "un envío en USD");
    assert.equal(fraseServicio("usd_prepago"), "un envío en USD");
    assert.equal(fraseServicio("brl_cup"), "un envío a CUP");
    assert.equal(fraseServicio("cup_efectivo"), "una entrega en efectivo (CUP)");
    assert.equal(fraseServicio("usd_efectivo"), "una entrega en efectivo (USD)");
    assert.equal(fraseServicio("recarga_nacional"), "una recarga");
    assert.equal(fraseServicio("recarga_internacional"), "una recarga");
});

function todosLosMensajesPara(candidato) {
    const mensajes = [];
    for (const familia of Object.keys(FAMILIAS)) {
        for (let indice = 0; indice < FAMILIAS[familia].variantes.length; indice++) {
            mensajes.push(renderizarMensaje(candidato, { familia, indice }));
        }
    }
    return mensajes;
}

// Nota: no todas las variantes mencionan el servicio explícitamente (hay
// ganchos genéricos, ej. "¿viste la tasa de hoy?") -- eso es intencional,
// pedido explícitamente ("puede usarse como broma/gancho sin necesariamente
// mostrar una cifra/servicio"). Lo que SÍ debe cumplirse siempre: cuando el
// mensaje menciona un servicio, es el correcto, y JAMÁS aparece uno
// incorrecto (ver "servicioMencionado" -- al menos una variante de cada
// familia usa ${ctx.servicio}, así que en el conjunto completo el servicio
// correcto aparece varias veces).

test("MLC: cuando el servicio se menciona, es MLC -- nunca aparece CUP/USD/recarga; el servicio correcto aparece en al menos una variante", () => {
    const c = { ...CANDIDATO_BASE, tipoFavorito: "mlc" };
    const mensajes = todosLosMensajesPara(c);
    for (const msg of mensajes) assert.doesNotMatch(msg, /\bCUP\b|\bUSD\b|recarga/i);
    assert.ok(mensajes.some(m => /MLC/.test(m)), "el servicio real debe aparecer en al menos una variante");
});

test("USD: cuando el servicio se menciona, es USD -- nunca aparece CUP/MLC/recarga; el servicio correcto aparece en al menos una variante", () => {
    const c = { ...CANDIDATO_BASE, tipoFavorito: "usd_clasica" };
    const mensajes = todosLosMensajesPara(c);
    for (const msg of mensajes) assert.doesNotMatch(msg, /\bCUP\b|MLC|recarga/i);
    assert.ok(mensajes.some(m => /USD/.test(m)));
});

test("CUP (transferencia, brl_cup): cuando el servicio se menciona, es CUP -- nunca dice 'efectivo'; aparece en al menos una variante", () => {
    const c = { ...CANDIDATO_BASE, tipoFavorito: "brl_cup" };
    const mensajes = todosLosMensajesPara(c);
    for (const msg of mensajes) assert.doesNotMatch(msg, /efectivo/i);
    assert.ok(mensajes.some(m => /CUP/.test(m)));
});

test("efectivo (cup_efectivo/usd_efectivo) conserva el contexto y se expresa de forma conversacional", () => {
    for (const tipo of ["cup_efectivo", "usd_efectivo"]) {
        const c = { ...CANDIDATO_BASE, tipoFavorito: tipo };
        const mensajes = todosLosMensajesPara(c);
        for (const msg of mensajes) assert.doesNotMatch(msg, /transferencia/i);
        const moneda = tipo === "cup_efectivo" ? "CUP" : "USD";
        assert.ok(mensajes.some(m => new RegExp(`${moneda} en efectivo`).test(m)));
    }
});

test("servicio_especifico: integra el contexto en lenguaje hablado, sin paréntesis técnicos", () => {
    const casos = [
        ["brl_cup", /CUP/],
        ["usd_clasica", /USD/],
        ["mlc", /MLC/],
        ["cup_efectivo", /CUP en efectivo/],
        ["usd_efectivo", /USD en efectivo/],
        ["recarga_nacional", /una recarga/]
    ];
    for (const [tipo, esperado] of casos) {
        const c = { ...CANDIDATO_BASE, tipoFavorito: tipo };
        const mensajes = FAMILIAS.servicio_especifico.variantes
            .map((_, indice) => renderizarMensaje(c, { familia: "servicio_especifico", indice }));
        for (const msg of mensajes) {
            assert.doesNotMatch(msg, /\([^)]*\)/, `no debe haber ficha técnica: ${msg}`);
            assert.doesNotMatch(msg, /servicio|modalidad/i, `no debe haber lenguaje administrativo: ${msg}`);
        }
        assert.ok(mensajes.some(m => esperado.test(m)), `debe aparecer el contexto real para ${tipo}`);
    }
});

test("servicio_especifico: una recarga nunca se llama 'envío' cuando se menciona la acción", () => {
    for (const tipo of ["recarga_nacional", "recarga_internacional"]) {
        const c = { ...CANDIDATO_BASE, nombre: "María", tipoFavorito: tipo };
        const mensajes = FAMILIAS.servicio_especifico.variantes
            .map((_, indice) => renderizarMensaje(c, { familia: "servicio_especifico", indice }));
        for (const msg of mensajes) assert.doesNotMatch(msg, /envío/i, `no debe llamar envío a una recarga: ${msg}`);
        assert.ok(mensajes.some(m => /recarga/i.test(m)), "debe existir una propuesta explícita de recarga");
    }
});

test("recarga (nacional/internacional) mantiene el contexto de recarga -- nunca aparece una moneda de transferencia/efectivo", () => {
    for (const tipo of ["recarga_nacional", "recarga_internacional"]) {
        const c = { ...CANDIDATO_BASE, tipoFavorito: tipo };
        const mensajes = todosLosMensajesPara(c);
        for (const msg of mensajes) assert.doesNotMatch(msg, /\bCUP\b|\bUSD\b|\bMLC\b|entrega en efectivo/i);
        assert.ok(mensajes.some(m => /recarga/i.test(m)));
    }
});

test("sin tipo_favorito conocido -> nunca inventa un servicio específico (ni MLC/CUP/USD/recarga/efectivo)", () => {
    const c = { ...CANDIDATO_BASE, tipoFavorito: null };
    const mensajes = todosLosMensajesPara(c);
    for (const msg of mensajes) assert.doesNotMatch(msg, /\bMLC\b|\bCUP\b|\bUSD\b|recarga|entrega en efectivo/i);
    assert.ok(mensajes.some(m => /un envío/.test(m)));
});

test("el pool no recupera expresiones CRM o cierres rechazados", () => {
    const c = { ...CANDIDATO_BASE, tipoFavorito: "brl_cup" };
    const mensajes = todosLosMensajesPara(c).join("\n").toLowerCase();
    for (const frase of [
        "hacemos lo de cuba", "cuba queda por aquí cuando quieras", "si te pinta",
        "si te provoca", "¿resolvemos?", "¿le damos?", "aquí estoy",
        "¿cambiaste de idea?", "aquella", "aquellos", "aquel envío"
    ]) {
        assert.doesNotMatch(mensajes, new RegExp(frase.replace(/[?]/g, "\\$&")));
    }
});

// ── Nunca inventa cantidades ni tasas ──

test("ninguna variante, para ningún servicio, incluye un dígito -- nunca inventa monto ni tasa", () => {
    const candidatos = ["mlc", "usd_clasica", "brl_cup", "cup_efectivo", "usd_efectivo", "recarga_nacional", null]
        .map(tipoFavorito => ({ ...CANDIDATO_BASE, tipoFavorito, ultimoMonto: 5551234 }));
    for (const c of candidatos) {
        for (const msg of todosLosMensajesPara(c)) {
            assert.doesNotMatch(msg, /\d/, `no debe haber dígitos en: "${msg}"`);
        }
    }
});

test("el monto real del candidato (ultimoMonto) nunca aparece literal en ningún mensaje generado", () => {
    const c = { ...CANDIDATO_BASE, tipoFavorito: "usd_clasica", ultimoMonto: 5551234 };
    for (const msg of todosLosMensajesPara(c)) {
        assert.doesNotMatch(msg, /5551234/);
    }
});

// ── Variedad real ──

test("solo ofrece tres variantes contextuales a una cotización real; no familias de saludos", () => {
    assert.equal(FAMILIAS.servicio_especifico.variantes.length, 3);
    assert.deepEqual(familiasElegibles("1-3d", false), []);
    assert.deepEqual(familiasElegibles("1-3d", true), ["servicio_especifico"]);
    const preview = generarMensajePreview({ ...CANDIDATO_BASE, tipoFavorito: null });
    assert.equal(preview, null);
});

test("caso José: cotización CUP antigua produce un seguimiento contextual y útil", () => {
    const preview = generarMensajePreview({ ...CANDIDATO_BASE, nombre: "José García", tipoFavorito: "brl_cup", fechaIntento: horasAtras(200) }, { rng: rngSecuencia([0, 0]) });
    assert.match(preview.mensaje, /consultaste un envío a CUP/);
    assert.match(preview.mensaje, /cálculo actualizado/);
    assert.doesNotMatch(preview.mensaje, /¿qué tal el día|pasé a saludarte|¿alguna novedad/i);
});

test("el Director no recurre a saludos si no hay servicio real, aunque la cotización sea antigua", () => {
    const c = { ...CANDIDATO_BASE, tipoFavorito: null, fechaIntento: horasAtras(200) };
    assert.equal(elegirFamiliaVariante(c), null);
});

// ── Selección determinista/inyectable (nunca Math.random() en los tests) ──

test("selección determinista: la MISMA secuencia de rng produce SIEMPRE el mismo resultado", () => {
    const c = { ...CANDIDATO_BASE, tipoFavorito: "mlc" };
    const r1 = elegirFamiliaVariante(c, { rng: rngSecuencia([0.4, 0.6]) });
    const r2 = elegirFamiliaVariante(c, { rng: rngSecuencia([0.4, 0.6]) });
    assert.deepEqual(r1, r2);
});

// ── "Otra variante" realmente cambia cuando hay alternativas ──

test('"otra variante": puede variar el enfoque contextual, no volver a un saludo vacío', () => {
    const c = { ...CANDIDATO_BASE, tipoFavorito: "brl_cup", fechaIntento: horasAtras(120) };
    const rng = rngSecuencia([0, 0.8]);
    const excluir = { familia: "servicio_especifico", indice: 0 };
    const resultado = elegirFamiliaVariante(c, { rng, excluir });
    assert.notDeepEqual({ familia: resultado.familia, indice: resultado.indice }, excluir);
});

test('no crea oportunidades solo por antigüedad; sin historial de servicio no hay opciones', () => {
    const c = { ...CANDIDATO_BASE, tipoFavorito: null, fechaIntento: horasAtras(5) };
    assert.equal(totalOpciones(antiguedadTono(c.fechaIntento), false), 0);
});

// ── El backend nunca escribe ni envía WhatsApp (garantía estructural) ──

test("recuperacion-mensajes.js no importa la base de datos ni el cliente de WhatsApp -- estructuralmente no puede escribir ni enviar", () => {
    const codigo = fs.readFileSync(path.join(__dirname, "..", "src", "services", "recuperacion-mensajes.js"), "utf8");
    assert.doesNotMatch(codigo, /require\(["']\.\.\/\.\.\/db["']\)/);
    assert.doesNotMatch(codigo, /require\(["']\.\/zapi["']\)/);
    assert.doesNotMatch(codigo, /enviarMensaje|enviarSeguro|enviarConDelay/);
    assert.doesNotMatch(codigo, /\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
});

test("generarMensajePreview: no muta el objeto candidato recibido", () => {
    const c = { ...CANDIDATO_BASE, tipoFavorito: "mlc" };
    const copia = JSON.parse(JSON.stringify(c));
    generarMensajePreview(c, { rng: rngSecuencia([0.1, 0.1]) });
    assert.deepEqual(c, copia);
});

// ── Endpoint: auth + re-validación del candidato ──

test("GET /admin/recuperacion/mensaje está registrado con adminReadLimiter + verificarToken", () => {
    const codigo = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    assert.match(codigo, /app\.get\("\/admin\/recuperacion\/mensaje",\s*adminReadLimiter,\s*verificarToken/);
});

test("la ruta SIEMPRE re-valida contra la DB (obtenerCandidatoRecuperablePorTelefono) -- nunca confía en datos del query/body como si fueran el candidato", () => {
    const codigo = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    const bloque = codigo.slice(codigo.indexOf('"/admin/recuperacion/mensaje"'), codigo.indexOf('"/admin/recuperacion/mensaje"') + 900);
    assert.match(bloque, /obtenerCandidatoRecuperablePorTelefono/);
    // Los únicos datos que la ruta toma directamente del cliente son phone
    // y los campos de exclusión (para "otra variante") -- nunca nombre,
    // tipoFavorito, fechaIntento ni servicio.
    assert.doesNotMatch(bloque, /req\.query\.(nombre|tipoFavorito|servicio|fechaIntento)/);
});

test("obtenerCandidatoRecuperablePorTelefono: un teléfono que ya NO cumple el predicado (ej. ya operó, se bloqueó) -> null, aunque el frontend insista", async (t) => {
    t.mock.method(pool, "query", async () => ({ rows: [] })); // el WHERE ya lo descartó en la DB real
    const r = await recuperacionService.obtenerCandidatoRecuperablePorTelefono("5511900040099");
    assert.equal(r, null);
});

test("obtenerCandidatoRecuperablePorTelefono: candidato que SÍ sigue vigente -> devuelve sus datos reales (no lo que mande el frontend)", async (t) => {
    t.mock.method(pool, "query", async () => ({
        rows: [{
            phone: "5511900040001", nombre: "Lourdes Abreu", estado: "aguardando_comprovante",
            tipo_favorito: "mlc", ultimo_monto: "500", fecha_intento: horasAtras(50),
            estado_crm: "cotizado", ultimo_recordatorio: null, tipo_ultimo_recordatorio: null
        }]
    }));
    const r = await recuperacionService.obtenerCandidatoRecuperablePorTelefono("5511900040001");
    assert.equal(r.prioridad, "alta");
    assert.equal(r.servicio, "MLC");
});
