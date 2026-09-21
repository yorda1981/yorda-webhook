"use strict";

// ─────────────────────────────────────────────────────────
// PRUEBAS AUTOMÁTICAS — recargas dinámicas desde el dashboard
// (src/flows/recarga-flow.js). El dashboard (Configuración de Recargas)
// es la fuente de verdad: leerRecargas() filtra "activa = true" y
// "disponible_hasta IS NULL OR disponible_hasta >= NOW()" (fecha límite
// opcional de Internacional). Esta fase agrega: selección natural,
// número cubano con variantes de formato, resumen obligatorio antes del
// PIX, cambios/cancelación, y revalidación en cada paso.
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
    leerRecargas, mostrarMenuRecargas, intentarSeleccionDirecta, seleccionarRecarga,
    procesarNumeroRecarga, confirmarResumenRecarga, cambiarModalidadRecarga, cambiarNumeroRecarga
} = require("../src/flows/recarga-flow");

test.beforeEach(() => { mensajesEnviados = []; });

function mockRecargas(t, recargasActivas) {
    const customers = new Map();
    t.mock.method(pool, "query", async (sql, params = []) => {
        if (/SELECT \* FROM recargas[\s\S]*WHERE activa = true/.test(sql)) {
            return { rows: recargasActivas };
        }
        if (/^SELECT phone FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ phone: row.phone }] : [] };
        }
        if (/^SELECT \* FROM customers WHERE phone = \$1/.test(sql)) {
            const row = customers.get(params[0]);
            return { rows: row ? [{ ...row }] : [] };
        }
        // Regex específico de guardarCliente (customer-memory.js) -- distingue
        // su UPDATE del resto de "UPDATE customers SET ..." que pueda disparar
        // otro servicio en el camino (ej. crm.actualizarEstadoCRM dentro de
        // enviarPIX), que de otro modo pisarían esta captura posicional.
        if (/INSERT INTO customers/.test(sql) || (/UPDATE customers SET/.test(sql) && /ultimo_monto/.test(sql))) {
            const row = customers.get(params[0]) || { phone: params[0] };
            // Suficiente para estos tests: capturamos monto/tipo/estado por posición
            // (mismo orden que guardarCliente en customer-memory.js).
            if (params[2] != null) row.ultimo_monto = params[2];
            if (params[3] != null) row.tipo_favorito = params[3];
            if (params[8] != null) row.estado = params[8];
            if (params[5] != null) row.tarjeta_frecuente = params[5];
            customers.set(params[0], row);
            return { rows: [] };
        }
        return { rows: [] };
    });
    return customers;
}

const NACIONAL = { tipo: "nacional", precio: 100, descripcion: "2.000 CUP", activa: true };
const INTERNACIONAL = { tipo: "internacional", precio: 145, descripcion: "600 CUP x6", activa: true };

// ── Menú ──

test("solo Nacional activa -> ofrece únicamente Nacional, sin decir 'tenemos dos'", async (t) => {
    mockRecargas(t, [NACIONAL]);
    const msg = await mostrarMenuRecargas("5511900000001");
    assert.match(msg, /Recarga Nacional/i);
    assert.doesNotMatch(msg, /internacional/i);
    assert.doesNotMatch(msg, /tenemos dos/i);
});

test("solo Internacional activa -> ofrece únicamente Internacional", async (t) => {
    mockRecargas(t, [INTERNACIONAL]);
    const msg = await mostrarMenuRecargas("5511900000002");
    assert.match(msg, /Recarga Internacional/i);
    assert.doesNotMatch(msg, /Recarga Nacional/i);
});

test("ambas activas -> ofrece las dos", async (t) => {
    mockRecargas(t, [NACIONAL, INTERNACIONAL]);
    const msg = await mostrarMenuRecargas("5511900000003");
    assert.match(msg, /Recarga Nacional/i);
    assert.match(msg, /Recarga Internacional/i);
});

test("ninguna activa -> no ofrece una recarga inexistente, explica que no está disponible", async (t) => {
    mockRecargas(t, []);
    await mostrarMenuRecargas("5511900000004");
    const ultimo = mensajesEnviados[mensajesEnviados.length - 1]?.msg || "";
    assert.match(ultimo, /no tenemos recargas disponibles/i);
});

test("leerRecargas: refleja exactamente lo que el dashboard tiene activo ahora mismo", async (t) => {
    mockRecargas(t, [NACIONAL]);
    const recargas = await leerRecargas();
    assert.equal(recargas.length, 1);
    assert.equal(recargas[0].tipo, "nacional");
});

// ── Selección natural ──

test("seleccionarRecarga: nombre de modalidad ('internacional') entre dos opciones", async (t) => {
    const customers = mockRecargas(t, [NACIONAL, INTERNACIONAL]);
    await seleccionarRecarga("5511900000010", "internacional", true);
    const row = customers.get("5511900000010");
    assert.equal(row.tipo_favorito, "recarga_internacional");
    assert.equal(row.estado, "aguardando_numero_recarga");
});

test("seleccionarRecarga: ordinal ('la primera')", async (t) => {
    const customers = mockRecargas(t, [NACIONAL, INTERNACIONAL]);
    await seleccionarRecarga("5511900000011", "la primera", true);
    assert.equal(customers.get("5511900000011").tipo_favorito, "recarga_nacional");
});

test("seleccionarRecarga: 'esa' con una única opción activa -> selecciona esa", async (t) => {
    const customers = mockRecargas(t, [INTERNACIONAL]);
    await seleccionarRecarga("5511900000012", "esa", true);
    assert.equal(customers.get("5511900000012").tipo_favorito, "recarga_internacional");
});

test("seleccionarRecarga: 'esa' con dos opciones activas -> ambiguo, pregunta en vez de adivinar", async (t) => {
    const customers = mockRecargas(t, [NACIONAL, INTERNACIONAL]);
    await seleccionarRecarga("5511900000013", "esa", true);
    assert.equal(customers.get("5511900000013"), undefined, "no debe haber elegido ninguna modalidad todavía");
});

test("intentarSeleccionDirecta: 'quiero una recarga internacional' salta directo a Internacional sin mostrar el menú completo", async (t) => {
    const customers = mockRecargas(t, [NACIONAL, INTERNACIONAL]);
    const r = await intentarSeleccionDirecta("5511900000014", "quiero una recarga internacional");
    assert.notEqual(r, null);
    assert.equal(customers.get("5511900000014").tipo_favorito, "recarga_internacional");
});

test("intentarSeleccionDirecta: mensaje que no nombra ninguna modalidad -> null (el caller debe mostrar el menú)", async (t) => {
    mockRecargas(t, [NACIONAL, INTERNACIONAL]);
    const r = await intentarSeleccionDirecta("5511900000015", "quiero una recarga");
    assert.equal(r, null);
});

// ── Número cubano: variantes de formato ──

for (const [raw, esperado] of [
    ["51234567", "51234567"],
    ["+5351234567", "51234567"],
    ["53 51234567", "51234567"],
    ["+53 51234567", "51234567"],
]) {
    test(`procesarNumeroRecarga: acepta formato "${raw}" -> normaliza a ${esperado}`, async (t) => {
        const customers = mockRecargas(t, [NACIONAL]);
        customers.set("5511900000020", { phone: "5511900000020", tipo_favorito: "recarga_nacional", estado: "aguardando_numero_recarga" });
        await procesarNumeroRecarga("5511900000020", raw, true);
        assert.equal(customers.get("5511900000020").tarjeta_frecuente, esperado);
    });
}

test("procesarNumeroRecarga: número inválido -> explica brevemente, NUNCA silencio", async (t) => {
    const customers = mockRecargas(t, [NACIONAL]);
    customers.set("5511900000021", { phone: "5511900000021", tipo_favorito: "recarga_nacional", estado: "aguardando_numero_recarga" });
    await procesarNumeroRecarga("5511900000021", "123", true);
    assert.ok(mensajesEnviados.length > 0, "debe responder algo, nunca quedarse en silencio");
    assert.match(mensajesEnviados[mensajesEnviados.length - 1].msg, /número cubano válido/i);
    assert.notEqual(customers.get("5511900000021").estado, "confirmando_recarga");
});

// ── Resumen obligatorio antes del PIX ──

test("procesarNumeroRecarga: con número válido, pasa a 'confirmando_recarga' y manda un resumen (NO el PIX todavía)", async (t) => {
    const customers = mockRecargas(t, [NACIONAL]);
    customers.set("5511900000030", { phone: "5511900000030", tipo_favorito: "recarga_nacional", estado: "aguardando_numero_recarga" });
    await procesarNumeroRecarga("5511900000030", "58888888", true);
    const row = customers.get("5511900000030");
    assert.equal(row.estado, "confirmando_recarga");
    const ultimo = mensajesEnviados[mensajesEnviados.length - 1].msg;
    assert.match(ultimo, /Resumen de tu recarga/i);
    assert.match(ultimo, /58888888/);
    assert.match(ultimo, /R\$100/);
    assert.doesNotMatch(ultimo, /chave pix|pix copia e cola/i);
});

test("confirmarResumenRecarga: confirma y recién ahí avanza a 'aguardando_comprovante' (PIX)", async (t) => {
    const customers = mockRecargas(t, [NACIONAL]);
    customers.set("5511900000031", {
        phone: "5511900000031", tipo_favorito: "recarga_nacional", tarjeta_frecuente: "58888888", estado: "confirmando_recarga"
    });
    await confirmarResumenRecarga("5511900000031", true);
    const row = customers.get("5511900000031");
    assert.equal(row.estado, "aguardando_comprovante");
    assert.equal(Number(row.ultimo_monto), 100);
});

test("confirmarResumenRecarga: la modalidad venció/se desactivó mientras el cliente miraba el resumen -> no avanza a PIX", async (t) => {
    const customers = mockRecargas(t, []); // el admin la desactivó justo ahora
    customers.set("5511900000032", {
        phone: "5511900000032", tipo_favorito: "recarga_nacional", tarjeta_frecuente: "58888888", estado: "confirmando_recarga"
    });
    await confirmarResumenRecarga("5511900000032", true);
    const row = customers.get("5511900000032");
    assert.notEqual(row.estado, "aguardando_comprovante");
    assert.match(mensajesEnviados.map(m => m.msg).join(" | "), /ya no está disponible/i);
});

// ── Cambios / cancelación ──

test("cambiarModalidadRecarga: 'mejor la internacional' cambia de tipo y vuelve a pedir el número", async (t) => {
    const customers = mockRecargas(t, [NACIONAL, INTERNACIONAL]);
    customers.set("5511900000040", { phone: "5511900000040", tipo_favorito: "recarga_nacional", estado: "confirmando_recarga" });
    await cambiarModalidadRecarga("5511900000040", "internacional", true);
    const row = customers.get("5511900000040");
    assert.equal(row.tipo_favorito, "recarga_internacional");
    assert.equal(row.estado, "aguardando_numero_recarga");
});

test("cambiarNumeroRecarga: vuelve a 'aguardando_numero_recarga' sin perder la modalidad ya elegida", async (t) => {
    const customers = mockRecargas(t, [NACIONAL]);
    customers.set("5511900000041", { phone: "5511900000041", tipo_favorito: "recarga_nacional", estado: "confirmando_recarga" });
    await cambiarNumeroRecarga("5511900000041", true);
    const row = customers.get("5511900000041");
    assert.equal(row.estado, "aguardando_numero_recarga");
    assert.equal(row.tipo_favorito, "recarga_nacional", "la modalidad no debe perderse al pedir de nuevo el número");
});

// ── Disponibilidad cambiante mid-flow (ya cubierto arriba de forma directa) ──

test("modalidad desactivada DURANTE el flujo: procesarNumeroRecarga revalida antes de avanzar al resumen", async (t) => {
    const customers = mockRecargas(t, []); // el admin ya desactivó todo para cuando llega el número
    customers.set("5511900000005", { phone: "5511900000005", tipo_favorito: "recarga_nacional", estado: "aguardando_numero_recarga" });

    await procesarNumeroRecarga("5511900000005", "58888888", true);

    assert.match(mensajesEnviados.map(m => m.msg).join(" | "), /ya no está disponible/i);
    const row = customers.get("5511900000005");
    assert.notEqual(row.estado, "confirmando_recarga", "no debe avanzar al resumen con una modalidad ya desactivada");
});

test("modalidad SIGUE activa: procesarNumeroRecarga avanza con normalidad al resumen", async (t) => {
    const customers = mockRecargas(t, [NACIONAL]);
    customers.set("5511900000006", { phone: "5511900000006", tipo_favorito: "recarga_nacional", estado: "aguardando_numero_recarga" });

    await procesarNumeroRecarga("5511900000006", "58888888", true);

    const row = customers.get("5511900000006");
    assert.equal(row.estado, "confirmando_recarga");
    assert.equal(row.tarjeta_frecuente, "58888888");
});

test("seleccionarRecarga: si la lista se redujo entre mostrar el menú y elegir, no ofrece una opción inexistente", async (t) => {
    mockRecargas(t, [NACIONAL]); // ya solo queda 1 activa
    await seleccionarRecarga("5511900000007", "2", true); // el cliente había visto "2" cuando había dos
    const ultimo = mensajesEnviados[mensajesEnviados.length - 1]?.msg || "";
    assert.doesNotMatch(ultimo, /Responde 1 o 2/, "no debe ofrecer una opción 2 que ya no existe");
});
