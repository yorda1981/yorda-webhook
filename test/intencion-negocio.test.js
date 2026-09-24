"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — portón unificado de intención de negocio.
//
// Bug real: mensajes de negocio quedaban sin respuesta porque
//  (1) el filtro de gatillos de openai.js (debeResponder) los descartaba
//      antes de llegar a esConsultaTasas ("Boa tarde" + "O câmbio como
//      está hj"), o
//  (2) pasaban el portón pero ninguna regla reconocía "envio" y la IA de
//      respaldo contestaba IGNORAR -> silencio ("Quero realizar envio a
//      Cuba").
// El debounce (3500 ms, index.js) concatena los mensajes consecutivos con
// "\n" antes de llamar a procesarMensaje -- aquí se simula ese texto
// combinado. Mismo patrón de mocks que test/recarga-openai-router.test.js.
// ─────────────────────────────────────────────────────────

let mensajesEnviados = [];
const zapiPath = require.resolve("../src/services/zapi");
require.cache[zapiPath] = {
    id: zapiPath, filename: zapiPath, loaded: true,
    exports: {
        enviarMensaje: async (phone, msg) => { mensajesEnviados.push({ phone, msg }); return true; },
        enviarImagen: async () => {},
        enviarConDelay: async (phone, msg) => { mensajesEnviados.push({ phone, msg }); },
        mostrarEscribiendo: async () => {},
        calcularDelay: () => 0
    }
};

let cuentaLlamadasGPT = 0;
let respuestaGPT = async () => ({ texto: "IGNORAR", responseId: null });
const imagenFlowPath = require.resolve("../src/flows/imagen-flow");
require.cache[imagenFlowPath] = {
    id: imagenFlowPath, filename: imagenFlowPath, loaded: true,
    exports: {
        detectarImagenUnificada: async () => ({ tipo: "desconocido" }),
        detectarComprobantePDF: async () => ({ valido: false }),
        llamarAsistente: async (...args) => { cuentaLlamadasGPT++; return respuestaGPT(...args); }
    }
};

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const { procesarMensaje, logResultadoMensaje } = require("../src/services/openai");
const { esConsultaTasas, esIntencionSinMonto, esMensajeDeNegocio, canonizarIntencion } = require("../src/services/reglas-bot");

const TASAS_DEFAULT = { brl_0: 90, brl_100: 100, brl_500: 110, brl_1000: 120, usd1: 300, mlc: 250 };
const HORA_ATENCION_FIJA = new Date("2026-01-15T17:00:00.000Z").getTime(); // 14:00 en Brasil (UTC-3)

function norm(s) { return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }

function mockMundo(t) {
    t.mock.timers.enable({ apis: ["Date"], now: HORA_ATENCION_FIJA });
    const customers = new Map();
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^SELECT \* FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ ...row }] : [] };
        }
        if (/^SELECT \* FROM rates LIMIT 1/.test(sql)) return { rows: [TASAS_DEFAULT] };
        return { rows: [] };
    });
    return { customers };
}

async function procesar(phone, texto) {
    let resultado = "respondido";
    const r = await procesarMensaje(phone, texto, "Cliente", null, { onResultado: x => { resultado = x; } });
    return { r, resultado, enviados: mensajesEnviados.filter(m => m.phone === phone).map(m => m.msg) };
}

test.beforeEach(() => {
    cuentaLlamadasGPT = 0;
    mensajesEnviados = [];
    respuestaGPT = async () => ({ texto: "IGNORAR", responseId: null });
});

// ── Normalización ──

test("canonizarIntencion: hj->hoje, taxa->tasa, envio->enviar, transferência->transferir", () => {
    assert.equal(canonizarIntencion(norm("O câmbio como está hj")), "o cambio como esta hoje");
    assert.equal(canonizarIntencion(norm("qual a taxa")), "qual a tasa");
    assert.equal(canonizarIntencion(norm("quiero hacer un envío")), "quiero hacer un enviar");
    assert.equal(canonizarIntencion(norm("uma transferência")), "uma transferir");
});

// ── Clasificadores puros ──

for (const frase of ["O câmbio como está hj", "como está o câmbio hoje", "cambio hoy", "cuanto está el cambio", "qual a taxa hoje", "Boa tarde\nO câmbio como está hj"]) {
    test(`esConsultaTasas: "${frase.replace("\n", " / ")}" es consulta de tasas`, () => {
        assert.equal(esConsultaTasas(norm(frase)), true);
        assert.equal(esMensajeDeNegocio(norm(frase)), true);
    });
}

for (const frase of ["Quero realizar envio a Cuba", "Quero fazer um envio", "Quero enviar dinheiro", "Quiero hacer un envío", "Quiero mandar dinero a Cuba", "Boa tarde, quero enviar dinheiro pra Cuba"]) {
    test(`esIntencionSinMonto: "${frase}" es intención de envío`, () => {
        assert.equal(esIntencionSinMonto(norm(frase)), true);
        assert.equal(esMensajeDeNegocio(norm(frase)), true);
    });
}

test("esConsultaTasas conceptual: no se activa con monto ni con 'cambio de tarjeta'", () => {
    assert.equal(esConsultaTasas(norm("cambio do cartão hoje")), false);
    assert.equal(esConsultaTasas(norm("el cambio para 500?")), false, "la rama conceptual no mira mensajes con monto");
    assert.equal(esMensajeDeNegocio(norm("hola como estas")), false, "un saludo no abre el portón aunque la regex histórica de tasas lo matchee");
});

test("esIntencionSinMonto conceptual: 'quero enviar o comprovante' no es envío de dinero", () => {
    assert.equal(esIntencionSinMonto(norm("quero realizar o envio do comprovante")), false);
});

test("mensajes ajenos al negocio no son de negocio", () => {
    for (const f of ["oi tudo bem como vai", "vou ao mercado hoje", "me manda uma foto do cachorro", "feliz cumpleaños amigo"])
        assert.equal(esMensajeDeNegocio(norm(f)), false, f);
});

// ── Router completo (texto combinado por el debounce) ──

test("CASO 1: 'Boa tarde' + 'O câmbio como está hj' -> responde con las tasas vigentes (no muere en el portón)", async (t) => {
    mockMundo(t);
    const { r, resultado } = await procesar("5511900070001", "Boa tarde\nO câmbio como está hj");
    assert.match(r, /Reales → CUP/);
    assert.match(r, /R\$100–499: 100 CUP/, "usa las tasas de la tabla rates, sin valores nuevos");
    assert.equal(resultado, "respondido");
    assert.equal(cuentaLlamadasGPT, 0);
});

test("CASO 2: 'Buenas tardes' + 'Quero realizar envio a Cuba' + 'Pôr favor' -> pregunta el monto, sin IA ni operación", async (t) => {
    const mundo = mockMundo(t);
    const { enviados, resultado } = await procesar("5511900070002", "Buenas tardes\nQuero realizar envio a Cuba\nPôr favor");
    // Cliente nuevo: saludo inicial + continúa con la intención (regla aprobada).
    assert.equal(enviados.length, 2);
    assert.match(enviados[0], /[Bb]uenas tardes/);
    assert.match(enviados[1], /Cuánto quieres enviar a Cuba/);
    assert.equal(resultado, "respondido");
    assert.equal(cuentaLlamadasGPT, 0);
    assert.equal(mundo.customers.get("5511900070002")?.ultimo_monto ?? null, null, "no inventa monto");
});

// Comportamiento PREEXISTENTE (no tocado): "dinheiro" activa esConsultaEntrega
// (lo interpreta como efectivo) y responde con la explicación de entrega +
// link de la calculadora. Lo importante aquí: nunca queda en silencio.
test("'Boa tarde, quero enviar dinheiro pra Cuba' -> responde (flujo de entrega existente), nunca silencio", async (t) => {
    mockMundo(t);
    const { enviados, resultado } = await procesar("5511900070003", "Boa tarde, quero enviar dinheiro pra Cuba");
    // Cliente nuevo: saludo inicial + continúa con la intención (regla aprobada).
    assert.equal(enviados.length, 2);
    assert.match(enviados[1], /calculadora/);
    assert.equal(resultado, "respondido");
    assert.equal(cuentaLlamadasGPT, 0);
});

test("'Quiero hacer un envío' (ES) -> pregunta el monto por el flujo de intención sin monto", async (t) => {
    mockMundo(t);
    const { enviados } = await procesar("5511900070004", "Quiero hacer un envío");
    assert.deepEqual(enviados, ["Perfecto 😊\n\n¿Cuánto deseas enviar?"]);
    assert.equal(cuentaLlamadasGPT, 0);
});

test("'Quero fazer um envio' (PT) -> pregunta el monto en portugués", async (t) => {
    mockMundo(t);
    const { enviados } = await procesar("5511900070005", "Quero fazer um envio, por favor");
    assert.deepEqual(enviados, ["Perfeito 😊\n\nQuanto você quer enviar?"]);
});

for (const [i, frase] of ["qual a taxa hoje", "cambio hoy", "Como está o câmbio hoje?", "cuanto está el cambio"].entries()) {
    test(`'${frase}' -> responde con las tasas vigentes`, async (t) => {
        mockMundo(t);
        const { r, resultado } = await procesar(`55119000701${i}0`, frase);
        assert.match(r, /Reales → CUP/);
        assert.equal(resultado, "respondido");
    });
}

test("mensajes consecutivos que JUNTOS expresan la intención ('Oi' + 'quero mandar' + 'pra Cuba')", async (t) => {
    mockMundo(t);
    const { enviados } = await procesar("5511900070020", "Oi\nquero mandar\npra Cuba");
    // Cliente nuevo: saludo inicial + continúa con la intención (regla aprobada).
    assert.equal(enviados.length, 2);
    assert.match(enviados[1], /Cuánto quieres enviar a Cuba/);
});

test("mensajes consecutivos ES: 'Hola' + 'a cómo está' + 'el cambio hoy' -> tasas", async (t) => {
    mockMundo(t);
    const { r } = await procesar("5511900070021", "Hola\na cómo está\nel cambio hoy");
    assert.match(r, /Reales → CUP/);
});

// ── Mensajes ajenos y logging ──

test("mensaje ajeno al negocio -> sigue ignorado en el portón, sin IA, motivo 'porton'", async (t) => {
    mockMundo(t);
    const { r, resultado, enviados } = await procesar("5511900070030", "tudo bem, vou ao mercado hoje");
    assert.equal(r, "");
    assert.deepEqual(enviados, []);
    assert.equal(resultado, "porton");
    assert.equal(cuentaLlamadasGPT, 0);

    // Con saludo delante (cliente nuevo): solo el saludo inicial, el resto
    // ajeno al negocio no genera nada más ni llama a la IA (regla aprobada).
    const conSaludo = await procesar("5511900070039", "oi tudo bem, vou ao mercado hoje");
    assert.equal(conSaludo.enviados.length, 1);
    assert.equal(cuentaLlamadasGPT, 0);
});

test("mensaje ajeno que pasa el portón por estado y la IA dice IGNORAR -> silencio, motivo 'ia_ignorar'", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900070031", { phone: "5511900070031", estado: "cotizacion_realizada" });
    const { r, resultado, enviados } = await procesar("5511900070031", "jaja mi perro se comio el zapato");
    assert.equal(r, "");
    assert.deepEqual(enviados, []);
    assert.equal(resultado, "ia_ignorar");
    assert.equal(cuentaLlamadasGPT, 1);
});

test("IA vacía -> motivo 'ia_vacio'; IA con error -> motivo 'ia_error'", async (t) => {
    const mundo = mockMundo(t);
    mundo.customers.set("5511900070032", { phone: "5511900070032", estado: "cotizacion_realizada" });
    respuestaGPT = async () => ({ texto: "", responseId: null });
    assert.equal((await procesar("5511900070032", "jaja mi perro se comio el zapato")).resultado, "ia_vacio");
    respuestaGPT = async () => { throw new Error("timeout"); };
    assert.equal((await procesar("5511900070032", "jaja mi perro se comio el zapato")).resultado, "ia_error");
});

test("mensaje de negocio no reconocido por reglas + IA IGNORAR -> respuesta fija segura, sin tasas ni montos", async (t) => {
    mockMundo(t);
    const { r, resultado } = await procesar("5511900070033", "tengo unas dudas sobre las remesas");
    assert.match(r, /tasa de hoy o ya tienes el monto/);
    assert.doesNotMatch(r, /\d/, "no cita ningún número");
    assert.equal(resultado, "respondido_rescate_ia_ignorar");
});

test("logResultadoMensaje: respondido -> MESSAGE_PROCESSED; silencios -> MESSAGE_DISCARDED con motivo; sin texto del cliente", (t) => {
    const lineas = [];
    t.mock.method(console, "log", (l) => lineas.push(JSON.parse(l)));
    logResultadoMensaje("5511988887777", "respondido");
    logResultadoMensaje("5511988887777", "porton");
    logResultadoMensaje("5511988887777", "ia_ignorar");
    logResultadoMensaje("5511988887777", "ia_vacio");
    logResultadoMensaje("5511988887777", "respondido_rescate_ia_ignorar");
    assert.deepEqual(lineas.map(l => [l.evento, l.resultado || l.motivo]), [
        ["MESSAGE_PROCESSED", "respondido"],
        ["MESSAGE_DISCARDED", "porton"],
        ["MESSAGE_DISCARDED", "ia_ignorar"],
        ["MESSAGE_DISCARDED", "ia_vacio"],
        ["MESSAGE_PROCESSED", "respondido_rescate_ia_ignorar"]
    ]);
    for (const l of lineas) {
        assert.equal(l.phone, "***7777");
        assert.deepEqual(Object.keys(l).sort(), ["evento", "phone", l.resultado ? "resultado" : "motivo", "ts"].sort());
    }
});
