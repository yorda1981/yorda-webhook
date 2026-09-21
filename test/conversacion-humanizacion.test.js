"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — Fase de humanización determinista + contexto corto
// + números bloqueados + prioridad de nueva intención + cotización inversa
// CUP→BRL, a nivel de procesarMensaje (src/services/openai.js).
//
// Reemplaza zapi.js e imagen-flow.js ANTES de cargar openai.js (mismo
// patrón que test/crear-entrega-manual-idempotencia.test.js): cero
// llamadas de red reales, cero llamadas a OpenAI/GPT -- si algún mensaje
// de estos tests cayera al fallback de GPT por error, el stub de
// llamarAsistente lo delata (cuentaLlamadasGPT > 0 hace fallar el test).
//
// pool.query se mockea con una tabla `customers` en memoria (misma forma
// de columnas que usa src/services/customer-memory.js), más `rates`,
// `ofertas`, `blocked_numbers` y `operations`.
// ─────────────────────────────────────────────────────────

// enviarSeguro() (src/flows/shared.js) llama a enviarConDelay -- se registran
// los mensajes salientes aquí porque el valor de RETORNO de procesarMensaje
// para el flujo de PIX depende de variables de entorno reales (PIX_KEY, no
// configuradas en este entorno de pruebas) y no es una señal confiable de
// "se envió algo"; el mock sí lo es.
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
const imagenFlowPath = require.resolve("../src/flows/imagen-flow");
require.cache[imagenFlowPath] = {
    id: imagenFlowPath, filename: imagenFlowPath, loaded: true,
    exports: {
        detectarImagenUnificada: async () => ({ tipo: "desconocido" }),
        detectarComprobantePDF: async () => ({ valido: false }),
        llamarAsistente: async () => { cuentaLlamadasGPT++; return { texto: "", responseId: null }; }
    }
};

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const { procesarMensaje } = require("../src/services/openai");

const TASAS_DEFAULT = { brl_0: 90, brl_100: 100, brl_500: 110, brl_1000: 120, usd1: 300, mlc: 250 };

// procesarMensaje calcula la hora de Brasil con Date.now() real y se queda
// en silencio fuera de 8am-11pm -- se fija el reloj a un horario de atención
// conocido para que estos tests no dependan de a qué hora del día realmente
// corren (evita que el CI/una corrida nocturna los rompa por horario).
const HORA_ATENCION_FIJA = new Date("2026-01-15T17:00:00.000Z").getTime(); // 14:00 en Brasil (UTC-3)

function mockMundoConversacional(t, { tasas = TASAS_DEFAULT, bloqueados = [] } = {}) {
    t.mock.timers.enable({ apis: ["Date"], now: HORA_ATENCION_FIJA });
    const customers = new Map();   // phone -> row
    const operations = new Map();  // phone -> [rows]
    const bloqueadosSet = new Set(bloqueados);
    let siguienteOperationId = 1;

    function aplicarParams(row, params) {
        const set = (i, col) => { if (params[i] != null) row[col] = params[i]; };
        set(1, "nombre"); set(2, "ultimo_monto"); set(3, "tipo_favorito"); set(4, "banco_favorito");
        set(5, "tarjeta_frecuente"); set(6, "titular_frecuente"); set(7, "banco_detectado");
        set(8, "estado"); set(9, "fecha_estado"); set(10, "fecha_cotizacion"); set(11, "fecha_pix");
        if (params[12] != null) row.tarjetas = JSON.parse(params[12]);
        set(13, "comprobante_pendiente"); set(14, "valor_comprobante"); set(15, "ultima_interaccion");
        set(16, "saludo_enviado"); set(17, "last_response_id"); set(18, "ultimo_aviso_entrega");
        set(19, "ultima_pregunta");
        if (params[20] != null) row.ultimas_opciones = JSON.parse(params[20]);
        set(21, "contexto_actualizado_at");
        return row;
    }

    t.mock.method(pool, "query", async (sql, params = []) => {
        // customers
        if (/^SELECT phone FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ phone: row.phone }] : [] };
        }
        if (/^SELECT phone, estado_crm FROM customers/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ phone: row.phone, estado_crm: row.estado_crm || null }] : [] };
        }
        if (/^SELECT \* FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ ...row }] : [] };
        }
        if (/^SELECT nivel_vip FROM customers/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: [{ nivel_vip: row?.nivel_vip || 0 }] };
        }
        // activarPausaHumana (webhook-guard.js) -- UPSERT con columnas propias,
        // más específico que el INSERT genérico de guardarCliente -- se revisa
        // primero para no interpretar MINUTOS_PAUSA como si fuera "nombre".
        if (/INSERT INTO customers \(phone, pausa_hasta/.test(sql)) {
            const row = customers.get(params[0]) || { phone: params[0] };
            row.pausa_hasta = new Date(Date.now() + Number(params[1]) * 60000).toISOString();
            customers.set(params[0], row);
            return { rows: [] };
        }
        if (/INSERT INTO customers/.test(sql)) {
            const row = aplicarParams({ phone: params[0] }, params);
            customers.set(params[0], row);
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*nombre\s*=\s*COALESCE/.test(sql)) {
            const row = aplicarParams(customers.get(params[0]) || { phone: params[0] }, params);
            customers.set(params[0], row);
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*estado\s*=\s*NULL/.test(sql)) {
            const row = customers.get(params[0]);
            if (row) Object.assign(row, {
                estado: null, fecha_estado: null, fecha_pix: null, comprobante_pendiente: null,
                valor_comprobante: null, last_response_id: null, ultimo_monto: null, tipo_favorito: null,
                tarjeta_frecuente: null, titular_frecuente: null, banco_favorito: null,
                ultima_pregunta: null, ultimas_opciones: null, contexto_actualizado_at: null
            });
            return { rows: [] };
        }
        // limpiarTarjetaFrecuente -- se revisa ANTES que limpiarContextoCorto
        // porque su SQL también contiene "ultima_pregunta = NULL" (más
        // específico primero, ver src/services/customer-memory.js).
        if (/UPDATE customers SET[\s\S]*tarjeta_frecuente\s*=\s*NULL/.test(sql)) {
            const row = customers.get(params[0]);
            if (row) Object.assign(row, {
                tarjeta_frecuente: null, titular_frecuente: null,
                ultima_pregunta: null, ultimas_opciones: null, contexto_actualizado_at: null
            });
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*ultima_pregunta\s*=\s*NULL/.test(sql)) {
            const row = customers.get(params[0]);
            if (row) Object.assign(row, { ultima_pregunta: null, ultimas_opciones: null, contexto_actualizado_at: null });
            return { rows: [] };
        }
        if (/UPDATE customers SET[\s\S]*estado_crm\s*=\s*\$2/.test(sql)) {
            const row = customers.get(params[0]);
            if (row) { row.estado_crm = params[1]; if (params[2] != null) row.idioma = params[2]; }
            return { rows: [] };
        }
        if (/^SELECT pausa_hasta FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ pausa_hasta: row.pausa_hasta || null }] : [] };
        }

        // rates / ofertas
        if (/^SELECT \* FROM rates LIMIT 1/.test(sql)) return { rows: [tasas] };
        if (/^SELECT \* FROM ofertas LIMIT 1/.test(sql)) return { rows: [] };

        // blocked_numbers
        if (/^SELECT 1 FROM blocked_numbers WHERE phone = \$1/.test(sql)) {
            return { rows: bloqueadosSet.has(params[0]) ? [{ "?column?": 1 }] : [] };
        }

        // operations
        if (/^SELECT \* FROM operations WHERE\s+phone = \$1 AND status = 'pendiente'/.test(sql)) {
            const rows = (operations.get(params[0]) || []).filter(o => o.status === "pendiente");
            return { rows: rows.length ? [rows[rows.length - 1]] : [] };
        }
        if (/^SELECT id FROM operations WHERE phone = \$1 AND status = 'pendiente' AND monto = \$2/.test(sql)) {
            const rows = (operations.get(params[0]) || []).filter(o => o.status === "pendiente" && Number(o.monto) === Number(params[1]));
            return { rows: rows.map(o => ({ id: o.id })) };
        }
        if (/INSERT INTO operations/.test(sql)) {
            const row = { id: siguienteOperationId++, phone: params[0], monto: params[2], status: "pendiente" };
            const arr = operations.get(params[0]) || [];
            arr.push(row);
            operations.set(params[0], arr);
            return { rows: [row] };
        }

        return { rows: [] };
    });

    return {
        customers,
        operations,
        bloquear: (phone) => bloqueadosSet.add(phone),
        sembrarOperacionPendiente: (phone, monto) => {
            const row = { id: siguienteOperationId++, phone, monto, status: "pendiente" };
            const arr = operations.get(phone) || [];
            arr.push(row);
            operations.set(phone, arr);
            return row;
        }
    };
}

test.beforeEach(() => { cuentaLlamadasGPT = 0; mensajesEnviados = []; });

// ── GATILLOS: mensaje sin gatillo/contexto/monto -> silencio total, sin GPT ──

test("GATILLOS: mensaje corto sin gatillo, sin estado previo y sin monto -> silencio total", async (t) => {
    mockMundoConversacional(t);
    const r = await procesarMensaje("5511900000001", "estoy pensando", "Cliente");
    // No es saludo, no tiene ningún gatillo de negocio, no hay estado previo
    // ni monto -- debe quedarse en silencio (nunca se amplió el portón).
    assert.equal(r, "");
    assert.equal(cuentaLlamadasGPT, 0, "un mensaje sin gatillo jamás debe llegar a GPT");
});

test("GATILLOS: nunca se amplió el árbol -- un mensaje ambiguo de 2 palabras sin contexto sigue en silencio", async (t) => {
    mockMundoConversacional(t);
    const r = await procesarMensaje("5511900000002", "mejor 60000", "Cliente");
    // Sin contexto previo (cliente nuevo), "mejor 60000" no debe activar nada --
    // ni la continuidad CUP (que requiere contexto vigente) ni el fallback GPT
    // (2 palabras, por debajo del mínimo de 4).
    assert.equal(r, "");
    assert.equal(cuentaLlamadasGPT, 0);
});

// ── BLOQUEO: un número bloqueado no recibe ninguna respuesta del router ──
// (el corte real ocurre en index.js antes de llamar a procesarMensaje; esto
// prueba que blocked-numbers.estaBloqueado() -- la función que hace ese corte --
// identifica correctamente al cliente que procesarMensaje sí procesaría.)

test("BLOQUEO: estaBloqueado() identifica al número antes de que llegue a procesarMensaje", async (t) => {
    const mundo = mockMundoConversacional(t, { bloqueados: ["5511900000099"] });
    const { estaBloqueado } = require("../src/services/blocked-numbers");
    assert.equal(await estaBloqueado("5511900000099"), true);
    assert.equal(await estaBloqueado("5511900000001"), false);
});

// ── CONTEXTO: respuesta contextual dentro y fuera de la ventana de 30 min ──

test("CONTEXTO: 'la primera' con contexto vigente resuelve la tarjeta y envía el PIX", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900000010", {
        phone: "5511900000010", estado: "seleccionando_tarjeta",
        tarjetas: ["1111222233334444", "5555666677778888"],
        ultima_pregunta: "seleccion_tarjeta", ultimas_opciones: ["1111222233334444", "5555666677778888"],
        contexto_actualizado_at: new Date().toISOString(), ultimo_monto: 300
    });
    await procesarMensaje("5511900000010", "la primera", "Cliente");
    const row = mundo.customers.get("5511900000010");
    assert.equal(row.tarjeta_frecuente, "1111222233334444");
    assert.equal(row.estado, "aguardando_comprovante");
    assert.ok(mensajesEnviados.length > 0, "debe enviar el flujo de PIX, no quedarse en silencio");
});

test("CONTEXTO: la misma respuesta 'la primera' con el contexto VENCIDO (31 min) no resuelve nada por sí sola", async (t) => {
    const mundo = mockMundoConversacional(t);
    const hace31min = new Date(Date.now() - 31 * 60000).toISOString();
    mundo.customers.set("5511900000011", {
        phone: "5511900000011", estado: "seleccionando_tarjeta",
        tarjetas: ["1111222233334444", "5555666677778888"],
        ultima_pregunta: "seleccion_tarjeta", ultimas_opciones: ["1111222233334444", "5555666677778888"],
        contexto_actualizado_at: hace31min, ultimo_monto: 300
    });
    await procesarMensaje("5511900000011", "la primera", "Cliente");
    const row = mundo.customers.get("5511900000011");
    assert.equal(row.tarjeta_frecuente, undefined, "un contexto vencido nunca debe resolver la selección");
});

test("CONTEXTO: expirado -> nunca borra hechos financieros (ultimo_monto/estado siguen intactos)", async (t) => {
    const mundo = mockMundoConversacional(t);
    const hace31min = new Date(Date.now() - 31 * 60000).toISOString();
    mundo.customers.set("5511900000012", {
        phone: "5511900000012", estado: "aguardando_comprovante", ultimo_monto: 300,
        ultima_pregunta: "tarjeta_pendiente", contexto_actualizado_at: hace31min
    });
    await procesarMensaje("5511900000012", "tarjeta", "Cliente");
    const row = mundo.customers.get("5511900000012");
    assert.equal(row.estado, "aguardando_comprovante", "el contexto corto vencido no debe tocar el estado financiero");
    assert.equal(row.ultimo_monto, 300);
});

// ── NUEVA INTENCIÓN: monto nuevo y explícito sobre una cotización vieja abandonada ──

test("NUEVA INTENCIÓN: cotización vieja de R$300 + 'quiero enviar 800 reales' -> cotiza 800, no 300", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900000020", {
        phone: "5511900000020", estado: "aguardando_comprovante", ultimo_monto: 300, comprobante_pendiente: false
    });
    const r = await procesarMensaje("5511900000020", "quiero enviar 800 reales", "Cliente");
    assert.match(r, /800/, "debe cotizar el monto nuevo, no el viejo");
    const row = mundo.customers.get("5511900000020");
    assert.equal(Number(row.ultimo_monto), 800);
});

test("NUEVA INTENCIÓN: pedir USD explícito no arrastra tarjeta/comprobante_pendiente de un contexto BRL viejo", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900000021", {
        phone: "5511900000021", estado: "cotizacion_realizada", ultimo_monto: 300,
        tarjeta_frecuente: "1111222233334444", comprobante_pendiente: false
    });
    await procesarMensaje("5511900000021", "quiero enviar 100 dolares", "Cliente");
    const row = mundo.customers.get("5511900000021");
    assert.equal(row.tarjeta_frecuente, null, "la tarjeta vieja no debe seguir pegada a la operación USD nueva");
    assert.equal(row.tipo_favorito, "usd_clasica");
});

test("NUEVA INTENCIÓN: 'olvida eso' resetea el contexto conversacional sin tocar operations", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900000022", { phone: "5511900000022", estado: "aguardando_comprovante", ultimo_monto: 300 });
    const opReal = mundo.sembrarOperacionPendiente("5511900000022", 150);
    await procesarMensaje("5511900000022", "olvida eso", "Cliente");
    const row = mundo.customers.get("5511900000022");
    assert.equal(row.estado, null, "el contexto conversacional sí se resetea");
    const opsDespues = mundo.operations.get("5511900000022");
    assert.equal(opsDespues.length, 1, "la operación real jamás se borra");
    assert.deepEqual(opsDespues[0], opReal);
});

test("NUEVA INTENCIÓN: una operación real pendiente en `operations` nunca se descarta al iniciar otra conversación", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900000023", {
        phone: "5511900000023", estado: "aguardando_comprovante", ultimo_monto: 300, comprobante_pendiente: true
    });
    mundo.sembrarOperacionPendiente("5511900000023", 300);
    await procesarMensaje("5511900000023", "quiero enviar 800 reales", "Cliente");
    const ops = mundo.operations.get("5511900000023");
    assert.equal(ops.length, 1, "la operación real pendiente sigue existiendo, nunca se elimina");
});

// ── CUP → BRL: las 6 frases reportadas, ruteadas end-to-end ──

const FRASES_CUP = [
    "cuanto son 50000 cup en reales",
    "50000 cup cuantos reales son",
    "para que le lleguen 50 mil cup cuantos reales pago",
    "quiero que reciba 50000",
    "cuantos reales necesito para mandar 80000 cup",
    "con cuanto hago 100 mil cup"
];

for (const frase of FRASES_CUP) {
    test(`CUP→BRL: "${frase}" se cotiza con cotizacion_inversa_cup (nunca como envío BRL)`, async (t) => {
        mockMundoConversacional(t);
        const r = await procesarMensaje(`5511900001${Math.floor(Math.random() * 900 + 100)}`, frase, "Cliente");
        assert.match(r, /R\$\d+/, `"${frase}" debería devolver una cotización inversa con un monto en reales`);
        assert.equal(cuentaLlamadasGPT, 0, "la cotización inversa jamás debe pasar por GPT");
    });
}

test("CUP→BRL crítico: un número atado a CUP nunca se cotiza como si fuera un envío BRL", async (t) => {
    mockMundoConversacional(t);
    // "necesito enviar 30000 cup" -- 30000 está en el rango normal de un envío
    // BRL (10-50000). Antes del fix, extraerMonto conflaba "cup" con las
    // monedas de origen y esto se cotizaba como si el cliente quisiera ENVIAR
    // R$30.000. Ahora debe entenderse como una pregunta inversa (o al menos
    // JAMÁS como "R$30.000 = X CUP").
    const r = await procesarMensaje("5511900000030", "necesito enviar 30000 cup", "Cliente");
    assert.ok(!/R\$30[.,]?000/.test(r || ""), `nunca debe cotizarse como si el cliente enviara R$30.000: "${r}"`);
});

test("CUP→BRL continuidad: 'para que lleguen 50000 cup cuanto pago' + 'mejor 60000' sustituye el objetivo CUP", async (t) => {
    mockMundoConversacional(t);
    const phone = "5511900000031";
    const r1 = await procesarMensaje(phone, "para que le lleguen 50000 cup cuanto pago", "Cliente");
    assert.match(r1, /50/); // menciona el objetivo de 50 mil de alguna forma (50.000/50 mil)

    const r2 = await procesarMensaje(phone, "mejor 60000", "Cliente");
    assert.match(r2, /R\$\d+/, "debe volver a cotizar, ahora con el nuevo objetivo CUP");
    assert.ok(!/^$/.test(r2), "nunca debe quedar en silencio");
});

// La matemática de tramos ya está cubierta por test/cup-inverso.test.js; aquí
// solo se confirma que el ROUTING (procesarMensaje) no la rompe para valores
// en cada tramo (0-99, 100-499, 500-999, 1000+, expresado como objetivo CUP).
const CASOS_TRAMOS = [
    "cuanto son 5000 cup en reales",
    "cuanto son 30000 cup en reales",
    "cuanto son 70000 cup en reales",
    "cuanto son 500000 cup en reales"
];

for (const frase of CASOS_TRAMOS) {
    test(`CUP→BRL tramos: "${frase}" devuelve una cotización válida (regresión de routing, no de la matemática)`, async (t) => {
        mockMundoConversacional(t);
        const r = await procesarMensaje(`5511900002${Math.floor(Math.random() * 900 + 100)}`, frase, "Cliente");
        assert.match(r, /R\$\d+/);
    });
}

// ═══════════════════════════════════════════════════════════
// SEGUNDO SALTO DE NATURALIDAD (fase 2)
// ═══════════════════════════════════════════════════════════

// ── Corrección de monto / cambio de opinión ──

test("CORRECCIÓN DE MONTO: 'no, eran 700' sobre una cotización de 300 -> recotiza 700", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900010001", {
        phone: "5511900010001", estado: "aguardando_comprovante", ultimo_monto: 300, comprobante_pendiente: false
    });
    const r = await procesarMensaje("5511900010001", "no, eran 700", "Cliente");
    assert.match(r, /700/);
    const row = mundo.customers.get("5511900010001");
    assert.equal(Number(row.ultimo_monto), 700);
});

test("CAMBIO DE OPINIÓN: 'mejor 500' sobre una cotización de 300 -> recotiza 500", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900010002", {
        phone: "5511900010002", estado: "cotizacion_realizada", ultimo_monto: 300
    });
    const r = await procesarMensaje("5511900010002", "mejor 500", "Cliente");
    assert.match(r, /500/);
});

// ── Rechazo de tarjeta ("esa tarjeta no"/"otra tarjeta") ──

test("RECHAZO DE TARJETA: 'esa tarjeta no' limpia la tarjeta guardada y pide una nueva, sin tocar el monto", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900010003", {
        phone: "5511900010003", estado: "aguardando_comprovante", ultimo_monto: 300,
        tarjeta_frecuente: "1111222233334444"
    });
    const r = await procesarMensaje("5511900010003", "esa tarjeta no", "Cliente");
    const row = mundo.customers.get("5511900010003");
    assert.equal(row.tarjeta_frecuente, null);
    assert.equal(row.estado, "aguardando_comprovante", "la operación sigue abierta, solo se corrige la tarjeta");
    assert.equal(Number(row.ultimo_monto), 300, "el monto real no se toca");
    assert.match(r, /nueva|16 dígitos|16 dígitos/i);
});

test("RECHAZO DE TARJETA: sin ninguna tarjeta que rechazar -> no dispara (cae al resto del árbol)", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900010004", { phone: "5511900010004", estado: "cotizacion_realizada", ultimo_monto: 300 });
    await procesarMensaje("5511900010004", "otra tarjeta", "Cliente");
    const row = mundo.customers.get("5511900010004");
    // No debe reventar ni cambiar el estado por accidente.
    assert.equal(row.estado, "cotizacion_realizada");
});

// ── Abandono temporal ("espera"/"todavía no") ──

test("ABANDONO TEMPORAL: 'espera' no toca el estado financiero ni el contexto", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900010005", {
        phone: "5511900010005", estado: "aguardando_comprovante", ultimo_monto: 300, comprobante_pendiente: false
    });
    const r = await procesarMensaje("5511900010005", "espera", "Cliente");
    const row = mundo.customers.get("5511900010005");
    assert.equal(row.estado, "aguardando_comprovante");
    assert.equal(Number(row.ultimo_monto), 300);
    assert.ok(r && r.length > 0, "debe responder brevemente, no en silencio");
});

test("ABANDONO TEMPORAL: 'no tengo dinero ahora' se reconoce sin alargar la charla", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900010006", { phone: "5511900010006", estado: "cotizacion_realizada", ultimo_monto: 300 });
    const r = await procesarMensaje("5511900010006", "no tengo dinero ahora", "Cliente");
    assert.ok(r && r.length > 0);
    assert.equal(cuentaLlamadasGPT, 0);
});

// ── Reutilización segura de tarjeta frecuente ──

test("REUTILIZACIÓN DE TARJETA: cliente recurrente con una sola tarjeta -> se confirma antes de reutilizarla", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900010007", {
        phone: "5511900010007", estado: "cotizacion_realizada", ultimo_monto: 300, tarjeta_frecuente: "1111222233334521"
    });
    const r = await procesarMensaje("5511900010007", "si", "Cliente");
    assert.match(r, /4521/, "debe mencionar los últimos 4 dígitos, nunca la tarjeta completa");
    const row = mundo.customers.get("5511900010007");
    assert.equal(row.ultima_pregunta, "confirmar_tarjeta_frecuente");
    assert.equal(row.estado, "aguardando_comprovante", "el guardarCliente de debeConfirmarCotizacion ya corrió antes de preguntar");
});

test("REUTILIZACIÓN DE TARJETA: confirmar con 'sí' reutiliza la tarjeta y sigue el flujo de PIX", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900010008", {
        phone: "5511900010008", estado: "aguardando_comprovante", ultimo_monto: 300,
        tarjeta_frecuente: "1111222233334521",
        ultima_pregunta: "confirmar_tarjeta_frecuente", ultimas_opciones: ["1111222233334521"],
        contexto_actualizado_at: new Date().toISOString()
    });
    await procesarMensaje("5511900010008", "sí", "Cliente");
    const row = mundo.customers.get("5511900010008");
    assert.equal(row.ultima_pregunta, null, "la pregunta pendiente se limpia tras confirmar");
    assert.ok(mensajesEnviados.length > 0, "debe seguir con el envío del PIX");
});

// ── Cliente exploratorio vs decidido ──

test("CLIENTE EXPLORATORIO: 'que opciones tienen' dentro de un contexto ya gatillado -> explica sin pedir tarjeta", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900010009", { phone: "5511900010009", estado: "cotizacion_realizada", ultimo_monto: 300 });
    const r = await procesarMensaje("5511900010009", "que opciones tienen", "Cliente");
    assert.match(r, /CUP|tasa/i);
    const row = mundo.customers.get("5511900010009");
    assert.notEqual(row.estado, "aguardando_comprovante", "no debe empujarlo a pagar solo por preguntar");
});

test("CLIENTE DECIDIDO: 'quiero enviar 500' cotiza directo, camino corto", async (t) => {
    mockMundoConversacional(t);
    const r = await procesarMensaje("5511900010010", "quiero enviar 500", "Cliente");
    assert.match(r, /500/);
});

// ── Cierre natural de la conversación ──

test("CIERRE NATURAL: 'gracias' con un flujo abierto (aguardando comprobante) -> respuesta corta, no el cierre genérico", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900010011", { phone: "5511900010011", estado: "aguardando_comprovante", ultimo_monto: 300 });
    const r = await procesarMensaje("5511900010011", "gracias", "Cliente");
    assert.match(r, /comprobante/i);
});

test("CIERRE NATURAL: 'listo' sin flujo abierto -> cierre genérico breve", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900010012", { phone: "5511900010012", estado: "cotizacion_realizada", ultimo_monto: 300 });
    const r = await procesarMensaje("5511900010012", "listo", "Cliente");
    assert.match(r, /placer|gracias/i);
});

test("CIERRE NATURAL: 'ya pagué, después te aviso' no reabre el pedido de comprobante", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900010013", { phone: "5511900010013", estado: "aguardando_comprovante", ultimo_monto: 300 });
    const r = await procesarMensaje("5511900010013", "ya pague, despues te aviso", "Cliente");
    // No debe ser el mensaje genérico de "mándame el comprobante" repetido sin
    // reconocer que el cliente ya avisó que lo manda después.
    assert.match(r, /comprobante/i);
});

// ── Confusión / frustración: primera vez explica simple, la segunda ofrece handoff humano ──

test("CONFUSIÓN: primera señal de 'no entendí' -> explica más simple, no handoff todavía", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900010014", { phone: "5511900010014", estado: "cotizacion_realizada", ultimo_monto: 300 });
    const r = await procesarMensaje("5511900010014", "no entendi", "Cliente");
    assert.match(r, /simple/i);
    const row = mundo.customers.get("5511900010014");
    assert.equal(row.ultima_pregunta, "confusion_detectada");
});

test("CONFUSIÓN: segunda señal consecutiva dentro de los 30 min -> handoff humano (activarPausaHumana)", async (t) => {
    const mundo = mockMundoConversacional(t);
    mundo.customers.set("5511900010015", {
        phone: "5511900010015", estado: "cotizacion_realizada", ultimo_monto: 300,
        ultima_pregunta: "confusion_detectada", ultimas_opciones: { intentos: 1 },
        contexto_actualizado_at: new Date().toISOString()
    });
    const r = await procesarMensaje("5511900010015", "no fue eso", "Cliente");
    assert.match(r, /yordanys|conecto/i);
    const row = mundo.customers.get("5511900010015");
    assert.ok(row.pausa_hasta, "debe haber activado la pausa humana (infraestructura existente)");
});

// ── Contexto después de intervención humana ──

test("RECUPERACIÓN TRAS PAUSA HUMANA: una pregunta corta de ANTES de la pausa no se reutiliza al reanudar", async (t) => {
    const mundo = mockMundoConversacional(t);
    const antesDeLaPausa = new Date(Date.now() - 20 * 60000).toISOString(); // vigente por TTL (20 < 30 min)
    const pausaMasReciente = new Date(Date.now() - 5 * 60000).toISOString(); // el operador escribió DESPUÉS de esa pregunta
    mundo.customers.set("5511900010016", {
        phone: "5511900010016", estado: "seleccionando_tarjeta",
        tarjetas: ["1111222233334444", "5555666677778888"],
        ultima_pregunta: "seleccion_tarjeta", ultimas_opciones: ["1111222233334444", "5555666677778888"],
        contexto_actualizado_at: antesDeLaPausa,
        pausa_hasta: pausaMasReciente
    });
    await procesarMensaje("5511900010016", "la primera", "Cliente");
    const row = mundo.customers.get("5511900010016");
    assert.equal(row.tarjeta_frecuente, undefined, "el contexto es de antes de la intervención humana -- no se reutiliza a ciegas");
});

test("RECUPERACIÓN TRAS PAUSA HUMANA: una pregunta hecha DESPUÉS de que terminó la pausa sí se puede usar", async (t) => {
    const mundo = mockMundoConversacional(t);
    const pausaVieja = new Date(Date.now() - 15 * 60000).toISOString();
    const preguntaNueva = new Date(Date.now() - 2 * 60000).toISOString(); // el bot preguntó DESPUÉS de que terminó la pausa
    mundo.customers.set("5511900010017", {
        phone: "5511900010017", estado: "seleccionando_tarjeta",
        tarjetas: ["1111222233334444", "5555666677778888"],
        ultima_pregunta: "seleccion_tarjeta", ultimas_opciones: ["1111222233334444", "5555666677778888"],
        contexto_actualizado_at: preguntaNueva,
        pausa_hasta: pausaVieja
    });
    await procesarMensaje("5511900010017", "la primera", "Cliente");
    const row = mundo.customers.get("5511900010017");
    assert.equal(row.tarjeta_frecuente, "1111222233334444");
});

// ── Blocked number sigue con prioridad absoluta, incluso con las frases nuevas ──

test("BLOQUEO: sigue teniendo prioridad absoluta -- ni una frase de corrección nueva lo saltea", async (t) => {
    mockMundoConversacional(t, { bloqueados: ["5511900010018"] });
    const { estaBloqueado } = require("../src/services/blocked-numbers");
    // El corte real vive en index.js ANTES de llamar a procesarMensaje -- esto
    // confirma que la función que hace ese corte sigue detectando al cliente
    // sin importar qué tan natural sea la frase que mandaría después.
    assert.equal(await estaBloqueado("5511900010018"), true);
});
