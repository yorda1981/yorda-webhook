"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS DE REGRESIÓN — dos bugs reales del router (src/services/openai.js):
//
// 1. SALUDO: solo se reconocía un saludo EXACTO de una lista; "Hola buenas
//    noches", "Hola, buenos días" o "Hola"+"Buenas" (debounce) caían en el
//    portón y quedaban en silencio. Ver separarSaludo en reglas-bot.js.
// 2. CONTEXTO PIX: tarjeta -> R$420 = 71.400 CUP -> "Sim" -> "Puede enviar o
//    pix" + "Por favor" terminaba volviendo a preguntar el monto ("Sim" no
//    era confirmación en PT, el pedido de PIX exigía frase exacta y la IA
//    de respaldo no conoce el estado).
// Mismo patrón de mocks que test/recarga-openai-router.test.js.
// ─────────────────────────────────────────────────────────

let enviados = [];
const zapiPath = require.resolve("../src/services/zapi");
require.cache[zapiPath] = {
    id: zapiPath, filename: zapiPath, loaded: true,
    exports: {
        enviarMensaje: async (phone, msg) => { enviados.push({ phone, msg }); return true; },
        enviarImagen: async () => {},
        enviarConDelay: async (phone, msg) => { enviados.push({ phone, msg }); return true; },
        mostrarEscribiendo: async () => {},
        calcularDelay: () => 0
    }
};

let llamadasGPT = 0;
let respuestaGPT = "IGNORAR";
let imagenesDetectadas = 0;
let pdfsDetectados = 0;
const imagenFlowPath = require.resolve("../src/flows/imagen-flow");
require.cache[imagenFlowPath] = {
    id: imagenFlowPath, filename: imagenFlowPath, loaded: true,
    exports: {
        detectarImagenUnificada: async () => { imagenesDetectadas++; return {}; },
        detectarComprobantePDF: async () => { pdfsDetectados++; return {}; },
        llamarAsistente: async () => { llamadasGPT++; return { texto: respuestaGPT, responseId: "r1" }; }
    }
};

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const { procesarMensaje } = require("../src/services/openai");
const { separarSaludo, esPedidoDePix, tieneOperacionEnCurso, contextoPagoConversacionalVencido, esSeguimientoEntrega, preguntaElMonto } = require("../src/services/reglas-bot");

const AHORA = new Date("2026-01-15T17:00:00.000Z").getTime(); // 14:00 en Brasil
const TASAS = { brl_0: 90, brl_100: 170, brl_500: 175, brl_1000: 180, usd1: 5.6, mlc: 5.2 };
const COLS = { 1: "nombre", 2: "ultimo_monto", 3: "tipo_favorito", 5: "tarjeta_frecuente", 8: "estado", 9: "fecha_estado",
    10: "fecha_cotizacion", 11: "fecha_pix", 13: "comprobante_pendiente", 16: "saludo_enviado", 17: "last_response_id",
    19: "ultima_pregunta", 21: "contexto_actualizado_at" };

function mundo(t, { operaciones = [] } = {}) {
    t.mock.timers.enable({ apis: ["Date"], now: AHORA });
    const customers = new Map();
    const escriturasOperaciones = [];
    const aplicar = (row, params) => { for (const [i, c] of Object.entries(COLS)) if (params[i] != null) row[c] = params[i]; return row; };
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/^SELECT phone FROM customers WHERE phone = \$1/.test(sql)) { const r = customers.get(params[0]); return { rows: r ? [{ phone: r.phone }] : [] }; }
        if (/^SELECT \* FROM customers WHERE phone = \$1/.test(sql)) { const r = customers.get(params[0]); return { rows: r ? [{ ...r }] : [] }; }
        if (/INSERT INTO customers/.test(sql)) { customers.set(params[0], aplicar({ phone: params[0] }, params)); return { rows: [] }; }
        if (/UPDATE customers SET[\s\S]*nombre\s*=\s*COALESCE/.test(sql)) { customers.set(params[0], aplicar(customers.get(params[0]) || { phone: params[0] }, params)); return { rows: [] }; }
        if (/UPDATE customers SET[\s\S]*current_quote_id\s*=\s*NULL/.test(sql)) {
            const r = customers.get(params[0]);
            if (r && !r.comprobante_pendiente && !r.comprobante_e2e && !r.comprobante_transaccion_id) Object.assign(r, { estado: null, current_quote_id: null, fecha_estado: null, fecha_pix: null,
                ultimo_monto: null, tipo_favorito: null, ultima_pregunta: null, ultimas_opciones: null,
                contexto_actualizado_at: null });
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*ultima_pregunta\s*=\s*NULL/.test(sql)) {
            const r = customers.get(params[0]);
            if (r) Object.assign(r, { ultima_pregunta: null, ultimas_opciones: null, contexto_actualizado_at: null });
            return { rows: [] };
        }
        if (/^SELECT \* FROM rates LIMIT 1/.test(sql)) return { rows: [TASAS] };
        if (/SELECT \* FROM operations\s+WHERE phone = \$1\s+ORDER BY id DESC LIMIT 1/.test(sql)) {
            const ops = operaciones.filter(o => o.phone === params[0]).sort((a, b) => b.id - a.id);
            return { rows: ops.slice(0, 1) };
        }
        if (/^\s*(UPDATE|DELETE FROM|INSERT INTO) operations\b/i.test(sql)) escriturasOperaciones.push(sql);
        return { rows: [] };
    });
    return { customers, escriturasOperaciones };
}

async function decir(phone, texto) {
    const desde = enviados.length;
    let resultado = "respondido";
    await procesarMensaje(phone, texto, "Cliente Teste", null, { onResultado: r => { resultado = r; } });
    return { msgs: enviados.slice(desde).filter(m => m.phone === phone).map(m => m.msg), resultado };
}

const PIDE_MONTO = /cu[aá]nto (quieres|deseas|vas a)|qu[eé] monto|quanto (voc[eê] )?(quer|vai|deseja)|dime el monto|me diz o valor/i;

test.beforeEach(() => { enviados = []; llamadasGPT = 0; respuestaGPT = "IGNORAR"; imagenesDetectadas = 0; pdfsDetectados = 0; });

// ── 1. SALUDO ──

test("separarSaludo: saludos simples y combinados, con puntuación/saltos/emojis", () => {
    for (const f of ["Hola", "Hola buenas noches", "Hola, buenos días!", "Buenas tardes", "Buenas noches 🌙", "Buenas", "Hola\nBuenas", "Oi, boa tarde", "Hola Yordanys", "Bom dia!!"])
        assert.deepEqual(separarSaludo(f), { tieneSaludo: true, resto: "" }, f);
});

test("separarSaludo: saludo + intención devuelve el resto ORIGINAL; palabras parecidas no son saludo", () => {
    assert.deepEqual(separarSaludo("Hola, buenas noches\nO câmbio como está hj"), { tieneSaludo: true, resto: "O câmbio como está hj" });
    assert.deepEqual(separarSaludo("Oi, boa tarde, quero enviar dinheiro"), { tieneSaludo: true, resto: "quero enviar dinheiro" });
    assert.equal(separarSaludo("Holanda").tieneSaludo, false);
    assert.equal(separarSaludo("hi5").tieneSaludo, false);
    assert.equal(separarSaludo("quero enviar 200").tieneSaludo, false);
});

for (const [i, saludo] of ["Hola", "Hola buenas noches", "Hola buenos días", "Buenas tardes", "Buenas noches", "Buenas", "Hola\nBuenas noches"].entries()) {
    test(`saludo inicial "${saludo.replace("\n", " / ")}" -> siempre se responde`, async (t) => {
        const w = mundo(t);
        const { msgs, resultado } = await decir(`55119000900${i}`, saludo);
        assert.equal(msgs.length, 1);
        assert.equal(resultado, "respondido");
        assert.ok(w.customers.get(`55119000900${i}`).saludo_enviado, "marca el saludo como enviado");
        assert.equal(llamadasGPT, 0);
    });
}

test("saludo + intención (cliente nuevo) -> saluda y continúa con la intención", async (t) => {
    mundo(t);
    const { msgs } = await decir("5511900091001", "Hola, buenas noches\ncambio hoy");
    assert.equal(msgs.length, 2);
    assert.match(msgs[1], /Reales → CUP/, "después del saludo responde la intención (tasas)");
    assert.equal(llamadasGPT, 0);
});

test("saludo + intención (ya saludado) -> no repite el saludo, solo continúa", async (t) => {
    const w = mundo(t);
    w.customers.set("5511900091002", { phone: "5511900091002", saludo_enviado: true });
    const { msgs } = await decir("5511900091002", "Buenas tardes, quiero hacer un envío");
    assert.deepEqual(msgs, ["Perfecto 😊\n\n¿Cuánto deseas enviar?"]);
});

test("después del saludo, un mensaje sin intención de negocio puede quedar en silencio (no es conversación abierta)", async (t) => {
    const w = mundo(t);
    w.customers.set("5511900091003", { phone: "5511900091003", saludo_enviado: true });
    const { msgs, resultado } = await decir("5511900091003", "que lindo dia hace");
    assert.deepEqual(msgs, []);
    assert.equal(resultado, "porton");
    const r2 = await decir("5511900091003", "Hola, que lindo dia hace");
    assert.deepEqual(r2.msgs, [], "saludo + charla sin negocio, ya saludado -> silencio");
});

test("saludo + charla sin negocio (cliente nuevo) -> se responde el saludo inicial y nada más", async (t) => {
    mundo(t);
    const { msgs, resultado } = await decir("5511900091004", "Hola, cómo estás?");
    assert.equal(msgs.length, 1);
    assert.equal(resultado, "respondido");
    assert.equal(llamadasGPT, 0);
});

// ── 2. CONTEXTO PIX ──

test("esPedidoDePix: por concepto, nunca cuando el cliente dice que ya pagó", () => {
    for (const f of ["puede enviar o pix por favor", "pode mandar o pix", "manda o pix", "pix", "el pix por favor", "qual a chave?", "me pasas el pix", "me envias la clave"])
        assert.equal(esPedidoDePix(f), true, f);
    for (const f of ["ya hice el pix", "fiz o pix", "paguei o pix", "mandei o comprovante do pix", "quiero enviar dinero"])
        assert.equal(esPedidoDePix(f), false, f);
});

test("tieneOperacionEnCurso: monto cotizado vigente sí; vencido (>2h), recarga o sin monto no", () => {
    const base = { estado: "cotizacion_realizada", ultimo_monto: 420, fecha_cotizacion: new Date(AHORA - 60 * 1000).toISOString() };
    assert.equal(tieneOperacionEnCurso(base, AHORA), true);
    assert.equal(tieneOperacionEnCurso({ ...base, estado: "aguardando_comprovante" }, AHORA), true);
    assert.equal(tieneOperacionEnCurso({ ...base, fecha_cotizacion: new Date(AHORA - 3 * 3600 * 1000).toISOString() }, AHORA), false);
    assert.equal(tieneOperacionEnCurso({ ...base, tipo_favorito: "recarga_nacional" }, AHORA), false);
    assert.equal(tieneOperacionEnCurso({ ...base, ultimo_monto: 0 }, AHORA), false);
    assert.equal(tieneOperacionEnCurso({ ...base, estado: null }, AHORA), false);
});

test("preguntaElMonto detecta respuestas que vuelven a pedir el monto (ES/PT)", () => {
    assert.equal(preguntaElMonto("¡Perfecto! ¿Cuánto quieres enviar? 😊"), true);
    assert.equal(preguntaElMonto("Quanto você quer enviar?"), true);
    assert.equal(preguntaElMonto("Llevamos tiempo ayudando a familias cubanas 😊"), false);
});

test("CASO REAL: tarjeta -> R$420 = 71.400 CUP -> 'Sim' -> 'Puede enviar o pix' + 'Por favor' -> avanza al PIX sin pedir monto", async (t) => {
    const w = mundo(t);
    respuestaGPT = "¡Perfecto! ¿Cuánto quieres enviar? 😊";
    const ph = "5511900092001";
    await decir(ph, "9205129912345678");
    const cot = await decir(ph, "420 reais");
    assert.match(cot.msgs[0], /R\$420 = 71\.400 CUP/);

    const sim = await decir(ph, "Sim");
    assert.equal(sim.msgs.length, 1, "'Sim' ya no queda en silencio");
    assert.doesNotMatch(sim.msgs[0], PIDE_MONTO);
    assert.equal(w.customers.get(ph).estado, "aguardando_comprovante");

    const pix = await decir(ph, "Puede enviar o pix\nPor favor");
    assert.ok(pix.msgs.length >= 1);
    for (const m of pix.msgs) assert.doesNotMatch(m, PIDE_MONTO);
    assert.match(pix.msgs.at(-1), /comprovante|comprobante/i, "llega al paso final del PIX");

    const c = w.customers.get(ph);
    assert.equal(Number(c.ultimo_monto), 420, "conserva el monto");
    assert.equal(c.tarjeta_frecuente, "9205129912345678", "conserva la tarjeta");
    assert.equal(c.estado, "aguardando_comprovante", "conserva la confirmación");
    assert.equal(llamadasGPT, 0, "no se delega a la IA");
});

test("'Sim' + pedido de PIX juntos en el mismo debounce -> confirma y avanza, sin pedir monto", async (t) => {
    const w = mundo(t);
    const ph = "5511900092002";
    w.customers.set(ph, { phone: ph, ultimo_monto: 420, tipo_favorito: "brl_cup", tarjeta_frecuente: "9205129912345678",
        estado: "cotizacion_realizada", fecha_cotizacion: new Date(AHORA - 60000).toISOString(), saludo_enviado: true });
    const { msgs } = await decir(ph, "Sim\nPuede enviar o pix\nPor favor");
    assert.ok(msgs.length >= 1);
    for (const m of msgs) assert.doesNotMatch(m, PIDE_MONTO);
    assert.equal(w.customers.get(ph).estado, "aguardando_comprovante");
    assert.equal(Number(w.customers.get(ph).ultimo_monto), 420);
});

test("pedido de PIX sin 'Sim' previo, con cotización en curso -> va al paso de PIX (no a la IA ni al monto)", async (t) => {
    const w = mundo(t);
    const ph = "5511900092003";
    w.customers.set(ph, { phone: ph, ultimo_monto: 420, tipo_favorito: "brl_cup", tarjeta_frecuente: "9205129912345678",
        estado: "cotizacion_realizada", fecha_cotizacion: new Date(AHORA - 60000).toISOString(), saludo_enviado: true });
    const { msgs } = await decir(ph, "Pode mandar o pix por favor");
    assert.equal(llamadasGPT, 0);
    assert.match(msgs[0], /tarjeta terminada en 5678|cartão terminado em 5678/);
    for (const m of msgs) assert.doesNotMatch(m, PIDE_MONTO);
});

test("con monto en curso, si la IA vuelve a preguntar el monto se reemplaza por la continuación de ESA operación", async (t) => {
    const w = mundo(t);
    respuestaGPT = "¡Claro! ¿Cuánto quieres enviar? 😊";
    const ph = "5511900092004";
    w.customers.set(ph, { phone: ph, ultimo_monto: 420, tipo_favorito: "brl_cup", tarjeta_frecuente: "9205129912345678",
        estado: "cotizacion_realizada", fecha_cotizacion: new Date(AHORA - 60000).toISOString(), saludo_enviado: true });
    const { msgs } = await decir(ph, "es seguro hacer esto con ustedes?");
    assert.equal(llamadasGPT, 1);
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /R\$420/);
    assert.match(msgs[0], /•••• 5678/);
    assert.doesNotMatch(msgs[0], PIDE_MONTO);
});

test("con monto en curso, 'quero enviar dinheiro pra Cuba' retoma la operación en vez de preguntar cuánto", async (t) => {
    const w = mundo(t);
    const ph = "5511900092005";
    w.customers.set(ph, { phone: ph, ultimo_monto: 420, tipo_favorito: "brl_cup", tarjeta_frecuente: "9205129912345678",
        estado: "cotizacion_realizada", fecha_cotizacion: new Date(AHORA - 60000).toISOString(), saludo_enviado: true });
    const { msgs } = await decir(ph, "quero fazer um envio pra Cuba");
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /R\$420/);
    assert.doesNotMatch(msgs[0], PIDE_MONTO);
});

test("sin operación en curso, la intención sin monto sigue preguntando cuánto (comportamiento existente)", async (t) => {
    const w = mundo(t);
    w.customers.set("5511900092006", { phone: "5511900092006", saludo_enviado: true });
    const { msgs } = await decir("5511900092006", "Quiero hacer un envío");
    assert.deepEqual(msgs, ["Perfecto 😊\n\n¿Cuánto deseas enviar?"]);
});

// ── Vigencia de la cotización retomada (solo reciente, mismo día, <= 2 h) ──

const HACE = (ms) => new Date(AHORA - ms).toISOString();
const CLIENTE_COTIZADO = (ph, fechaCotizacion) => ({ phone: ph, ultimo_monto: 420, tipo_favorito: "brl_cup",
    tarjeta_frecuente: "9205129912345678", estado: "cotizacion_realizada", fecha_cotizacion: fechaCotizacion, saludo_enviado: true });

test("VIGENCIA 1: cotización reciente de la conversación actual -> se retoma", async (t) => {
    const w = mundo(t);
    w.customers.set("5511900093001", CLIENTE_COTIZADO("5511900093001", HACE(20 * 60 * 1000)));
    const { msgs } = await decir("5511900093001", "quero fazer um envio pra Cuba");
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /R\$420/);
    assert.match(msgs[0], /•••• 5678/);
});

test("VIGENCIA 2: cotización de hace más de 2 h -> NO se retoma (se pregunta como conversación nueva)", async (t) => {
    const w = mundo(t);
    w.customers.set("5511900093002", CLIENTE_COTIZADO("5511900093002", HACE(2 * 3600 * 1000 + 60 * 1000)));
    const { msgs } = await decir("5511900093002", "quero fazer um envio pra Cuba");
    assert.equal(msgs.length, 1);
    assert.doesNotMatch(msgs[0], /R\$420/);
    assert.match(msgs[0], PIDE_MONTO);
});

test("VIGENCIA 3: cotización del día anterior -> nunca se retoma, aunque sea de minutos antes de medianoche", async (t) => {
    // 23:50 de ayer vs 00:10 de hoy (America/Sao_Paulo = UTC-3): 20 minutos, pero otro día.
    const ahora = new Date("2026-01-16T03:10:00.000Z").getTime();
    const ayer2350 = new Date("2026-01-16T02:50:00.000Z").toISOString();
    const hoy0000 = new Date("2026-01-16T03:00:00.000Z").toISOString();
    const base = { estado: "cotizacion_realizada", ultimo_monto: 420 };
    assert.equal(tieneOperacionEnCurso({ ...base, fecha_cotizacion: ayer2350 }, ahora), false);
    assert.equal(tieneOperacionEnCurso({ ...base, fecha_cotizacion: hoy0000 }, ahora), true);
    assert.equal(tieneOperacionEnCurso({ ...base, estado: "aguardando_comprovante", fecha_estado: ayer2350 }, ahora), false);
    assert.equal(tieneOperacionEnCurso(base, ahora), false, "sin fecha de cotización no se retoma");

    // En el router: cotización de ayer -> conversación nueva, sin arrastrar R$420.
    const w = mundo(t);
    w.customers.set("5511900093003", CLIENTE_COTIZADO("5511900093003", new Date(AHORA - 24 * 3600 * 1000 + 30 * 60 * 1000).toISOString()));
    respuestaGPT = "¿Cuánto quieres enviar? 😊";
    const { msgs } = await decir("5511900093003", "es seguro hacer esto con ustedes?");
    for (const m of msgs) assert.doesNotMatch(m, /R\$420|•••• 5678/);
});

test("VIGENCIA 4: una OPERACIÓN real pendiente (de ayer) no se pierde ni se trata como cotización vieja", async (t) => {
    const ph = "5511900093004";
    const w = mundo(t, { operaciones: [
        { id: 77, phone: ph, monto: 420, cup: 71400, tipo: "brl_cup", status: "pendiente", created_at: new Date(AHORA - 26 * 3600 * 1000).toISOString() }
    ] });
    // Tras registrar la operación real la sesión conversacional queda limpia (limpiarSesion).
    w.customers.set(ph, { phone: ph, saludo_enviado: true, estado: null });

    const nueva = await decir(ph, "Quiero hacer un envío");
    assert.match(nueva.msgs[0], /pendiente de verificación/i, "la operación real conserva prioridad y no reinicia el pago");

    const estado = await decir(ph, "cual es el estado de mi envio a Cuba");
    assert.match(estado.msgs[0], /R\$420/);
    assert.match(estado.msgs[0], /pendiente de verificación/i, "la operación sigue pendiente con su estado real");
    assert.doesNotMatch(estado.msgs[0], /envíame el comprobante|te envío el PIX/i);
    assert.deepEqual(w.escriturasOperaciones, [], "nada modificó la tabla operations");
});

test("operación manual pendiente tiene prioridad sobre saludo y nueva cotización", async (t) => {
    const ph = "5511900093015";
    const w = mundo(t, { operaciones: [{ id: 78, phone: ph, monto: 250, status: "pendiente" }] });
    w.customers.set(ph, { phone: ph, saludo_enviado: true, estado: null });
    const { msgs } = await decir(ph, "Necesito enviar R$500");
    assert.match(msgs[0], /pendiente de verificación/i);
    assert.doesNotMatch(msgs[0], /¿cuánto deseas enviar|¿te envío el PIX/i);
    assert.deepEqual(w.escriturasOperaciones, []);
});

test("una operación completada posterior no permite reabrir la cotización conversacional anterior", async (t) => {
    const ph = "5511900093018";
    const w = mundo(t, { operaciones: [{ id: 80, phone: ph, monto: 420, status: "completada",
        created_at: new Date(AHORA - 2 * 60000).toISOString(), updated_at: new Date(AHORA - 60000).toISOString() }] });
    w.customers.set(ph, { phone: ph, saludo_enviado: true, estado: "cotizacion_realizada", ultimo_monto: 420,
        tipo_favorito: "brl_cup", fecha_cotizacion: new Date(AHORA - 3 * 60000).toISOString() });
    const { msgs } = await decir(ph, "Hola");
    assert.equal(w.customers.get(ph).estado, null);
    assert.doesNotMatch(msgs[0], /R\$420|seguimos con el envío/i);
});

test("seguimiento de entrega consulta operación real; sin registro no vuelve a vender PIX", async (t) => {
    const ph = "5511900093016";
    mundo(t, { operaciones: [{ id: 79, phone: ph, monto: 250, status: "confirmada" }] });
    const { msgs } = await decir(ph, "Continúo en la espera");
    assert.match(msgs[0], /confirmado/i);
    assert.match(msgs[0], /transferencia/i);
    assert.doesNotMatch(msgs[0], /envía el PIX|¿te envío el PIX/i);

    const sinOperacion = "5511900093017";
    const r = await decir(sinOperacion, "¿Ya está lista?");
    assert.match(r.msgs[0], /No encuentro una transferencia registrada|No veo una operación registrada/i);
    assert.doesNotMatch(r.msgs[0], /¿Quieres hacer un envío/);
});

test("tras enviar comprobante, preguntar cuándo llegará consulta la operación y no vuelve a pedir PIX", async (t) => {
    const ph = "5511900093020";
    const w = mundo(t, { operaciones: [{ id: 90, phone: ph, monto: 420, cup: 71400, status: "confirmada" }] });
    w.customers.set(ph, { phone: ph, saludo_enviado: true, estado: "aguardando_comprovante",
        comprobante_pendiente: true, comprobante_e2e: "E123", ultimo_monto: 420 });
    const { msgs } = await decir(ph, "Ya envié el comprobante, ¿cuándo llegará la transferencia?");
    assert.match(msgs[0], /confirmad/i);
    assert.doesNotMatch(msgs.join(" "), /te envío el PIX|envíame el comprobante|¿cuánto deseas enviar/i);
    assert.equal(w.customers.get(ph).comprobante_pendiente, true);
    assert.deepEqual(w.escriturasOperaciones, []);
});

test("'Ya envié el PIX' con operación real informa estado sin crear otro PIX", async (t) => {
    const ph = "5511900093021";
    const w = mundo(t, { operaciones: [{ id: 91, phone: ph, monto: 300, status: "pendiente" }] });
    w.customers.set(ph, { phone: ph, saludo_enviado: true, estado: "aguardando_comprovante", ultimo_monto: 300 });
    const { msgs } = await decir(ph, "Ya envié el PIX");
    assert.match(msgs[0], /pendiente de verificación/i);
    assert.doesNotMatch(msgs.join(" "), /te envío el PIX|envía el PIX|haz el PIX/i);
    assert.deepEqual(w.escriturasOperaciones, []);
});

test("consulta de tasa actual después de una operación completada usa tasas actuales, no cotización vieja", async (t) => {
    const ph = "5511900093022";
    const w = mundo(t, { operaciones: [{ id: 92, phone: ph, monto: 300, status: "completada" }] });
    w.customers.set(ph, { phone: ph, saludo_enviado: true, estado: null, ultimo_monto: 300,
        fecha_cotizacion: new Date(AHORA - 3 * 24 * 3600 * 1000).toISOString() });
    const { msgs } = await decir(ph, "¿Cuál es la tasa actual?");
    assert.ok(msgs.length);
    assert.doesNotMatch(msgs.join(" "), /R\$300|transferencia pendiente/i);
    assert.deepEqual(w.escriturasOperaciones, []);
});

test("estado conversacional vencido se reconoce con el TTL existente de dos horas", () => {
    const ahora = AHORA;
    assert.equal(contextoPagoConversacionalVencido({ estado: "cotizacion_realizada", fecha_cotizacion: new Date(ahora - 2 * 3600 * 1000 - 1).toISOString() }, ahora), true);
    assert.equal(contextoPagoConversacionalVencido({ estado: "aguardando_comprovante", fecha_pix: new Date(ahora - 30 * 60 * 1000).toISOString() }, ahora), false);
    assert.equal(contextoPagoConversacionalVencido({ estado: "aguardando_comprovante" }, ahora), false);
});

test("seguimiento coloquial de entrega consulta el estado sin exigir posesivo", () => {
    for (const text of ["Continúo en la espera", "¿Sigo esperando?", "¿Ya está lista?", "Sigue pendiente"]) assert.equal(esSeguimientoEntrega(text), true, text);
});

test("adjunto de comprobante con caption de saludo se procesa antes del saludo", async (t) => {
    mundo(t);
    await procesarMensaje("5511900093012", "Hola", "Cliente", "https://media.test/proof.jpg");
    assert.equal(imagenesDetectadas, 1);
    assert.equal(enviados.some(m => /bienvenido|buenos d[ií]as|buenas tardes/i.test(m.msg)), false);
});

test("adjunto sin caption no se descarta por falta de texto", async (t) => {
    mundo(t);
    await procesarMensaje("5511900093013", "", "Cliente", "https://media.test/proof.jpg");
    assert.equal(imagenesDetectadas, 1);
});

test("PDF recibido después del TTL llega a revisión sin borrar estado ni comprobante", async (t) => {
    const ph = "5511900093014";
    const w = mundo(t);
    w.customers.set(ph, { phone: ph, estado: "aguardando_comprovante", ultimo_monto: 420,
        fecha_pix: new Date(AHORA - 3 * 3600 * 1000).toISOString(), comprobante_pendiente: false });
    await procesarMensaje(ph, "", "Cliente", "https://media.test/proof.pdf");
    assert.equal(pdfsDetectados, 1);
    assert.equal(w.customers.get(ph).estado, "aguardando_comprovante");
    assert.equal(w.customers.get(ph).ultimo_monto, 420);
});

test("operación antigua solo limpia el contexto de customers; no toca la operación financiera", async (t) => {
    const ph = "5511900093010";
    const w = mundo(t);
    w.customers.set(ph, { phone: ph, estado: "aguardando_comprovante", ultimo_monto: 420,
        tipo_favorito: "brl_cup", tarjeta_frecuente: "1111222233334444", fecha_pix: new Date(AHORA - 3 * 3600 * 1000).toISOString(),
        comprobante_pendiente: false });
    const { msgs } = await decir(ph, "Quiero enviar R$500");
    assert.equal(w.customers.get(ph).estado, "cotizacion_realizada");
    assert.equal(w.customers.get(ph).ultimo_monto, 500);
    assert.equal(w.customers.get(ph).tarjeta_frecuente, "1111222233334444", "la tarjeta guardada no se borra al vencer el contexto");
    assert.deepEqual(w.escriturasOperaciones, []);
    assert.ok(msgs.length);
});

test("comprobante en staging impide limpiar automáticamente la sesión vencida", async (t) => {
    const ph = "5511900093011";
    const w = mundo(t);
    w.customers.set(ph, { phone: ph, estado: "aguardando_comprovante", ultimo_monto: 420,
        fecha_pix: new Date(AHORA - 3 * 3600 * 1000).toISOString(), comprobante_pendiente: true,
        comprobante_e2e: "E12345678202601011000ABCDEFGHIJK" });
    await decir(ph, "Continúo en la espera");
    assert.equal(w.customers.get(ph).comprobante_pendiente, true);
    assert.equal(w.customers.get(ph).comprobante_e2e, "E12345678202601011000ABCDEFGHIJK");
});
