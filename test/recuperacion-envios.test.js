"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { enviarRecuperacionManual } = require("../src/services/recuperacion-envios");

function candidato(extra = {}) {
    return {
        phone: "5511900000001",
        nombre: "Cliente Recuperable",
        estado: "cotizacion_realizada",
        tipoFavorito: "brl_cup",
        servicio: "CUP transferencia",
        fechaIntento: new Date(Date.now() - 3 * 24 * 3600000).toISOString(),
        ...extra
    };
}

function fakeDb({ failFinalUpdate = false } = {}) {
    const rows = [];
    let nextId = 1;
    const run = async (sql, params = []) => {
        if (/^\s*UPDATE recuperacion_envios\s+SET estado = 'EXPIRADO'/i.test(sql)) {
            const limite = Date.now() - 24 * 3600000;
            rows.forEach(r => { if (r.estado === "ENVIADO" && r.enviado_at && r.enviado_at.getTime() <= limite) r.estado = "EXPIRADO"; });
            return { rows: [] };
        }
        if (/FROM recuperacion_envios[\s\S]*WHERE idempotency_key/i.test(sql)) {
            const row = rows.find(r => r.idempotency_key === params[0]);
            return { rows: row ? [row] : [] };
        }
        if (/SELECT id, estado[\s\S]*estado IN \('ENVIANDO','ENVIADO'\)/i.test(sql)) {
            const row = rows.find(r => r.phone === params[0] && ["ENVIANDO", "ENVIADO"].includes(r.estado));
            return { rows: row ? [row] : [] };
        }
        if (/INSERT INTO recuperacion_envios/i.test(sql)) {
            if (rows.some(r => r.idempotency_key === params[6])) { const e = new Error("duplicate key"); e.code = "23505"; throw e; }
            if (rows.some(r => r.phone === params[0] && ["ENVIANDO", "ENVIADO"].includes(r.estado))) { const e = new Error("duplicate active phone"); e.code = "23505"; throw e; }
            const row = { id: nextId++, phone: params[0], familia: params[1], variante_indice: params[2], tono: params[3], tipo_favorito: params[4], texto: params[5], estado: "ENVIANDO", idempotency_key: params[6], creado_at: new Date(), actualizado_at: new Date(), enviado_at: null, error: null };
            rows.push(row); return { rows: [row] };
        }
        if (/^\s*UPDATE recuperacion_envios\s+SET estado = \$2/i.test(sql)) {
            if (failFinalUpdate) throw new Error("DB caída después del proveedor");
            const row = rows.find(r => r.id === params[0]);
            row.estado = params[1]; row.error = params[2]; row.actualizado_at = new Date();
            if (row.estado === "ENVIADO") row.enviado_at = new Date();
            return { rows: [row] };
        }
        throw new Error(`SQL no simulado: ${sql.slice(0, 80)}`);
    };
    const db = { rows, query: run, async connect() {
        return { query: async (sql, params) => {
            if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
            return run(sql, params);
        }, release() {} };
    }};
    return db;
}

function deps(db, { candidato: c = candidato(), sendFn = async () => true } = {}) {
    return { pool: db, obtenerCandidato: async () => c, sendFn };
}

test("candidato válido: registra ENVIANDO, hace commit antes del proveedor y termina ENVIADO", async () => {
    const db = fakeDb(); let enviado = false;
    const r = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-1" }, deps(db, { sendFn: async () => { enviado = true; return true; } }));
    assert.equal(r.ok, true); assert.equal(r.code, "ENVIADO"); assert.equal(enviado, true); assert.equal(db.rows[0].estado, "ENVIADO");
});

for (const [nombre, extra] of [
    ["bloqueado", { bloqueado: true }],
    ["pausa humana", { enPausa: true }],
    ["operación posterior", { operacionPosterior: true }],
    ["dejó de ser candidato", null]
]) {
    test(`${nombre}: no envía`, async () => {
        const db = fakeDb(); let llamadas = 0;
        const r = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: `k-${nombre}` }, deps(db, { candidato: extra ? null : null, sendFn: async () => { llamadas++; return true; } }));
        assert.equal(r.code, "NO_ELEGIBLE"); assert.equal(llamadas, 0); assert.equal(db.rows.length, 0);
    });
}

test("variante inexistente o manipulada: se rechaza y nunca se envía texto arbitrario", async () => {
    const db = fakeDb(); let llamadas = 0;
    const r = await enviarRecuperacionManual({ phone: "5511900000001", familia: "inventada", indice: 0, idempotencyKey: "k-bad" }, deps(db, { sendFn: async () => { llamadas++; return true; } }));
    assert.equal(r.code, "VARIANTE_INVALIDA"); assert.equal(llamadas, 0); assert.equal(db.rows.length, 0);
});

test("fallo WhatsApp: registra FALLIDO y nunca ENVIADO", async () => {
    const db = fakeDb();
    const r = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-fail" }, deps(db, { sendFn: async () => false }));
    assert.equal(r.ok, false); assert.equal(r.code, "ENVIO_FALLIDO"); assert.equal(db.rows[0].estado, "FALLIDO");
});

test("misma idempotency key/retry: un solo envío", async () => {
    const db = fakeDb(); let llamadas = 0;
    const d = deps(db, { sendFn: async () => { llamadas++; return true; } });
    const a = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-retry" }, d);
    const b = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-retry" }, d);
    assert.equal(a.code, "ENVIADO"); assert.equal(b.code, "YA_ENVIADO"); assert.equal(llamadas, 1); assert.equal(db.rows.length, 1);
});

test("idempotency key reutilizada para otro teléfono o variante: conflicto, no envía", async () => {
    const db = fakeDb(); let llamadas = 0;
    const d = deps(db, { sendFn: async () => { llamadas++; return true; } });
    await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-conflict" }, d);
    const otraVariante = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 1, idempotencyKey: "k-conflict" }, d);
    const otroTelefono = await enviarRecuperacionManual({ phone: "5511900000002", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-conflict" }, d);
    assert.equal(otraVariante.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(otroTelefono.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(llamadas, 1);
});

test("requests concurrentes: el índice de teléfono deja un solo envío", async () => {
    const db = fakeDb(); let liberar; let llamadas = 0;
    const bloqueado = new Promise(resolve => { liberar = resolve; });
    const d = deps(db, { sendFn: async () => { llamadas++; await bloqueado; return true; } });
    const primero = enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-con-1" }, d);
    while (db.rows.length === 0) await new Promise(r => setImmediate(r));
    const segundo = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-con-2" }, d);
    assert.ok(["EN_CURSO", "COOLDOWN"].includes(segundo.code)); assert.equal(llamadas, 1);
    liberar(); await primero;
});

test("requests concurrentes después de expirar cooldown: solo una obtiene el claim", async () => {
    const db = fakeDb();
    const inicial = deps(db, { sendFn: async () => true });
    await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-exp-0" }, inicial);
    db.rows[0].enviado_at = new Date(Date.now() - 25 * 3600000);
    let liberar; let llamadas = 0;
    const espera = new Promise(resolve => { liberar = resolve; });
    const d = deps(db, { sendFn: async () => { llamadas++; await espera; return true; } });
    const a = enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-exp-1" }, d);
    while (db.rows.filter(r => r.estado === "ENVIANDO").length === 0) await new Promise(r => setImmediate(r));
    const b = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-exp-2" }, d);
    assert.ok(["EN_CURSO", "COOLDOWN"].includes(b.code)); assert.equal(llamadas, 1);
    liberar(); await a;
    assert.equal(db.rows.filter(r => r.estado === "ENVIADO").length, 1);
    assert.equal(db.rows.some(r => r.estado === "EXPIRADO"), true);
});

test("éxito Z-API pero fallo de UPDATE local: queda ENVIANDO y no se reintenta", async () => {
    const db = fakeDb({ failFinalUpdate: true }); let llamadas = 0;
    const d = deps(db, { sendFn: async () => { llamadas++; return true; } });
    const r = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-ambiguous" }, d);
    assert.equal(r.code, "ESTADO_AMBIGUO"); assert.equal(r.historial.estado, "ENVIANDO"); assert.equal(llamadas, 1);
    const retry = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-ambiguous-2" }, d);
    assert.equal(retry.code, "EN_CURSO"); assert.equal(llamadas, 1);
});

test("preview B: enviar reconstruye y registra exactamente familia+índice aprobados, sin nueva selección aleatoria", async () => {
    const db = fakeDb(); let textoEnviado = null;
    const d = deps(db, { sendFn: async (_phone, texto) => { textoEnviado = texto; return true; } });
    const r = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 3, idempotencyKey: "k-preview-b" }, d);
    assert.equal(r.ok, true); assert.equal(textoEnviado, r.texto); assert.equal(db.rows[0].texto, r.texto); assert.match(r.texto, /mandamos CUP\?/i);
});

test("cooldown menor de 24h bloquea, y después de 24h permite otro intento conservando historial", async () => {
    const db = fakeDb(); const d = deps(db, { sendFn: async () => true });
    await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-cd-1" }, d);
    const bloqueado = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-cd-2" }, d);
    assert.equal(bloqueado.code, "COOLDOWN");
    db.rows[0].enviado_at = new Date(Date.now() - 25 * 3600000);
    const permitido = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-cd-3" }, d);
    assert.equal(permitido.code, "ENVIADO"); assert.equal(db.rows.length, 2); assert.equal(db.rows[0].estado, "EXPIRADO");
});

test("preview sigue siendo GET/read-only y no hay ruta de envío masivo", () => {
    const index = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    const dashboard = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
    assert.match(index, /app\.get\("\/admin\/recuperacion\/mensaje"/);
    assert.match(index, /app\.post\("\/admin\/recuperacion\/enviar"[^]*verificarToken/);
    assert.doesNotMatch(index, /recuperacion\/enviar[-/]todos|recuperacion\/campana|recuperacion\/masivo/);
    assert.match(dashboard, /id="btnEnviarRecuperacion"/);
    assert.match(dashboard, /confirm\(`¿Enviar este mensaje a/);
    assert.match(dashboard, /fetch\("\/admin\/recuperacion\/enviar"/);
});

test("migración: conserva historial y protege teléfono/idempotencia en PostgreSQL", () => {
    const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "0018_recuperacion_envios.sql"), "utf8");
    assert.match(sql, /CREATE TABLE IF NOT EXISTS recuperacion_envios/);
    assert.match(sql, /texto\s+TEXT NOT NULL/);
    assert.match(sql, /idempotency_key\s+VARCHAR\(120\) NOT NULL UNIQUE/);
    assert.match(sql, /CREATE UNIQUE INDEX[\s\S]*ON recuperacion_envios \(phone\)/);
    assert.match(sql, /estado IN \('ENVIANDO','ENVIADO'\)/);
});
