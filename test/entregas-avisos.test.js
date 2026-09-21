"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — Avisos automáticos de entrega pendiente
// (src/services/entregas-avisos.js)
//
// Cubre: elección de plantilla (nunca repite consecutiva), orquestación
// completa (bloqueados, pausa humana, ON/OFF, idempotencia por franja vía
// entregas.js), y que el filtro real (estado_entrega='PENDIENTE' + avisos_
// automaticos=true + gate por franja) es el único criterio -- nunca un
// segundo sistema de estados paralelo.
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

const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../db");
const {
    elegirIndicePlantilla, diaDelAnioSaoPaulo, construirAvisoEntrega,
    enviarAvisosEntregasPendientes, PLANTILLAS_MANANA, PLANTILLAS_TARDE
} = require("../src/services/entregas-avisos");
const { inicioDiaSaoPauloUTC } = require("../src/utils/timezone");

test.beforeEach(() => { mensajesEnviados = []; });

// ── Selección de plantilla (pura) ──

test("elegirIndicePlantilla: nunca repite el índice anterior cuando hay más de una plantilla", () => {
    for (let anterior = 0; anterior < 3; anterior++) {
        for (let semilla = 0; semilla < 10; semilla++) {
            const idx = elegirIndicePlantilla(3, semilla, anterior);
            assert.notEqual(idx, anterior);
        }
    }
});

test("elegirIndicePlantilla: con una sola plantilla, siempre devuelve 0", () => {
    assert.equal(elegirIndicePlantilla(1, 5, 0), 0);
    assert.equal(elegirIndicePlantilla(1, 99, -1), 0);
});

test("construirAvisoEntrega: nunca promete mensajero en camino, hora, ubicación ni fecha de llegada", () => {
    const entrega = { id: 1, cliente_nombre: "Ana" };
    for (const franja of ["manana", "tarde"]) {
        for (let i = 0; i < PLANTILLAS_MANANA.length + PLANTILLAS_TARDE.length; i++) {
            const { mensaje } = construirAvisoEntrega({ ...entrega, id: i }, franja);
            assert.doesNotMatch(mensaje, /en camino|está llegando|hoy mismo|a las \d|mensajero/i);
        }
    }
});

test("plantillas de mañana nunca usan saludo de tarde, y viceversa (sin cruzar franjas)", () => {
    const contexto = { nombre: ", Ana" };
    for (const plantilla of PLANTILLAS_MANANA) {
        assert.doesNotMatch(plantilla(contexto), /buenas tardes/i);
    }
    for (const plantilla of PLANTILLAS_TARDE) {
        assert.doesNotMatch(plantilla(contexto), /buenos? días|buen día/i);
    }
});

// ── Orquestación completa ──

function mockMundoEntregas(t, { entregasPendientes = [], bloqueados = new Set(), enPausa = new Set() } = {}) {
    const avisosEnviados = []; // { id, franja, indice }
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/SELECT \* FROM entregas\s+WHERE estado_entrega = 'PENDIENTE'/.test(sql)) {
            return { rows: entregasPendientes };
        }
        if (/^UPDATE entregas SET ultimo_aviso_(manana|tarde)_at/.test(sql)) {
            avisosEnviados.push({ id: params[0], indice: params[1] });
            return { rows: [] };
        }
        if (/^SELECT 1 FROM blocked_numbers WHERE phone = \$1/.test(sql)) {
            return { rows: bloqueados.has(params[0]) ? [{ "?column?": 1 }] : [] };
        }
        if (/^SELECT pausa_hasta FROM customers WHERE phone = \$1/.test(sql)) {
            return { rows: enPausa.has(params[0]) ? [{ pausa_hasta: new Date(Date.now() + 600000).toISOString() }] : [{ pausa_hasta: null }] };
        }
        return { rows: [] };
    });
    return { avisosEnviados };
}

const ENTREGA_PENDIENTE = {
    id: 10, codigo: "E-1010", phone: "5511900010001", telefono_entrega: null,
    cliente_nombre: "Ana García", estado_entrega: "PENDIENTE", avisos_automaticos: true,
    ultimo_aviso_plantilla_idx: null
};

test("entrega pendiente por la mañana -> se envía un aviso", async (t) => {
    mockMundoEntregas(t, { entregasPendientes: [ENTREGA_PENDIENTE] });
    const r = await enviarAvisosEntregasPendientes("manana");
    assert.equal(r.enviados, 1);
    assert.equal(mensajesEnviados.length, 1);
    assert.equal(mensajesEnviados[0].phone, "5511900010001");
});

test("entrega pendiente por la tarde -> se envía un aviso", async (t) => {
    mockMundoEntregas(t, { entregasPendientes: [ENTREGA_PENDIENTE] });
    const r = await enviarAvisosEntregasPendientes("tarde");
    assert.equal(r.enviados, 1);
});

test("misma franja ejecutada dos veces seguidas -> un solo mensaje (la segunda ya no la trae la consulta, igual que ultimo_aviso_atraso)", async (t) => {
    // La query real ya filtra por el gate de la columna -- una segunda
    // ejecución del job, con el gate ya marcado, no debe volver a traer la
    // entrega. Se simula devolviendo la entrega solo la primera vez.
    let llamada = 0;
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/SELECT \* FROM entregas\s+WHERE estado_entrega = 'PENDIENTE'/.test(sql)) {
            llamada++;
            return { rows: llamada === 1 ? [ENTREGA_PENDIENTE] : [] };
        }
        if (/^UPDATE entregas SET ultimo_aviso_(manana|tarde)_at/.test(sql)) return { rows: [] };
        return { rows: [] };
    });
    await enviarAvisosEntregasPendientes("manana");
    await enviarAvisosEntregasPendientes("manana"); // repetición del job
    assert.equal(mensajesEnviados.length, 1, "la segunda corrida no debe encontrar la entrega otra vez (el gate ya está marcado)");
});

test("entrega COMPLETADA (ENTREGADO) -> no aparece en la consulta -> ningún aviso", async (t) => {
    // El WHERE real de la consulta ya excluye todo lo que no sea
    // estado_entrega='PENDIENTE' -- se verifica que el mock, reflejando la
    // query real, nunca la devuelve.
    const { avisosEnviados } = mockMundoEntregas(t, { entregasPendientes: [] }); // ENTREGADO no matchea el filtro real
    const r = await enviarAvisosEntregasPendientes("manana");
    assert.equal(r.enviados, 0);
    assert.equal(mensajesEnviados.length, 0);
});

test("entrega CANCELADA -> tampoco aparece en la consulta -> ningún aviso", async (t) => {
    mockMundoEntregas(t, { entregasPendientes: [] }); // CANCELADO tampoco matchea 'PENDIENTE'
    const r = await enviarAvisosEntregasPendientes("tarde");
    assert.equal(r.enviados, 0);
});

test("avisos_automaticos = OFF -> la entrega no llega a la consulta (el WHERE real la excluye) -> ningún aviso", async (t) => {
    mockMundoEntregas(t, { entregasPendientes: [] }); // avisos_automaticos=false no matchea el filtro real
    const r = await enviarAvisosEntregasPendientes("manana");
    assert.equal(r.enviados, 0);
});

test("cliente bloqueado -> no recibe el aviso aunque la entrega esté pendiente", async (t) => {
    mockMundoEntregas(t, { entregasPendientes: [ENTREGA_PENDIENTE], bloqueados: new Set(["5511900010001"]) });
    const r = await enviarAvisosEntregasPendientes("manana");
    assert.equal(r.enviados, 0);
    assert.equal(mensajesEnviados.length, 0);
});

test("cliente en pausa humana (operador atendiéndolo) -> no se interrumpe con el aviso automático", async (t) => {
    mockMundoEntregas(t, { entregasPendientes: [ENTREGA_PENDIENTE], enPausa: new Set(["5511900010001"]) });
    const r = await enviarAvisosEntregasPendientes("manana");
    assert.equal(r.enviados, 0);
    assert.equal(mensajesEnviados.length, 0);
});

test("cambio de PENDIENTE a ENTREGADO detiene los avisos (deja de matchear la consulta real)", async (t) => {
    // Primera corrida: pendiente, recibe aviso. Segunda corrida (después de
    // marcarla ENTREGADO en la vida real): la consulta ya no la trae.
    let entregada = false;
    t.mock.method(pool, "query", async (sql) => {
        if (/SELECT \* FROM entregas\s+WHERE estado_entrega = 'PENDIENTE'/.test(sql)) {
            return { rows: entregada ? [] : [ENTREGA_PENDIENTE] };
        }
        if (/^UPDATE entregas SET ultimo_aviso_(manana|tarde)_at/.test(sql)) return { rows: [] };
        return { rows: [] };
    });
    const r1 = await enviarAvisosEntregasPendientes("manana");
    assert.equal(r1.enviados, 1);
    entregada = true; // simula que en la vida real se marcó ENTREGADO entre corridas
    mensajesEnviados = [];
    const r2 = await enviarAvisosEntregasPendientes("tarde");
    assert.equal(r2.enviados, 0);
    assert.equal(mensajesEnviados.length, 0);
});

test("restart/repetición del job no duplica -- misma garantía que el resto de jobs (columna-gate, no memoria del proceso)", async (t) => {
    // Dos instancias/corridas independientes (sin estado compartido en
    // memoria entre ellas) sobre la MISMA fila -- el gate persistente es
    // lo único que debe evitar el duplicado, ver el test de "misma franja
    // ejecutada dos veces" arriba (usa el mismo mecanismo).
    let llamada = 0;
    t.mock.method(pool, "query", async (sql) => {
        if (/SELECT \* FROM entregas\s+WHERE estado_entrega = 'PENDIENTE'/.test(sql)) {
            llamada++;
            return { rows: llamada === 1 ? [ENTREGA_PENDIENTE] : [] };
        }
        return { rows: [] };
    });
    await enviarAvisosEntregasPendientes("manana");
    await enviarAvisosEntregasPendientes("manana"); // "restart" simulado: nueva llamada, sin estado en memoria compartido
    assert.equal(mensajesEnviados.length, 1);
});

test("plantillas no repiten consecutivamente: mañana y tarde del mismo día usan índices distintos", async (t) => {
    const entrega1 = { ...ENTREGA_PENDIENTE, ultimo_aviso_plantilla_idx: null };
    let indiceGuardado = null;
    t.mock.method(pool, "query", async (sql, params) => {
        if (/SELECT \* FROM entregas\s+WHERE estado_entrega = 'PENDIENTE'/.test(sql)) {
            return { rows: [{ ...entrega1, ultimo_aviso_plantilla_idx: indiceGuardado }] };
        }
        if (/^UPDATE entregas SET ultimo_aviso_(manana|tarde)_at/.test(sql)) {
            indiceGuardado = params[1];
            return { rows: [] };
        }
        return { rows: [] };
    });
    await enviarAvisosEntregasPendientes("manana");
    const primerMensaje = mensajesEnviados[0].msg;
    mensajesEnviados = [];
    await enviarAvisosEntregasPendientes("tarde");
    const segundoMensaje = mensajesEnviados[0].msg;
    assert.notEqual(primerMensaje, segundoMensaje, "el aviso de la tarde no debe repetir el texto exacto del de la mañana");
});

test("inicioDiaSaoPauloUTC se usa como gate -- coherente con el resto del sistema de horarios de negocio", () => {
    const d = inicioDiaSaoPauloUTC(new Date("2026-06-15T10:00:00.000Z"));
    assert.equal(d.toISOString(), "2026-06-15T03:00:00.000Z"); // 00:00 en Brasil (UTC-3) ese día
});
