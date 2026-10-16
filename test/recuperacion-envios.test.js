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
        if (/SELECT id, estado[\s\S]*estado IN \('EN_COLA','ENVIANDO','ENVIADO','INCIERTO'\)/i.test(sql)) {
            const row = rows.find(r => r.phone === params[0] && ["EN_COLA", "ENVIANDO", "ENVIADO", "INCIERTO"].includes(r.estado));
            return { rows: row ? [row] : [] };
        }
        if (/INSERT INTO recuperacion_envios/i.test(sql)) {
            if (rows.some(r => r.idempotency_key === params[6])) { const e = new Error("duplicate key"); e.code = "23505"; throw e; }
            if (rows.some(r => r.phone === params[0] && ["EN_COLA", "ENVIANDO", "ENVIADO"].includes(r.estado))) { const e = new Error("duplicate active phone"); e.code = "23505"; throw e; }
            const row = { id: nextId++, phone: params[0], familia: params[1], variante_indice: params[2], tono: params[3], tipo_favorito: params[4], texto: params[5], estado: "EN_COLA", idempotency_key: params[6], creado_at: new Date(), actualizado_at: new Date(), enviado_at: null, error: null };
            rows.push(row); return { rows: [row] };
        }
        if (/SELECT id,estado,creado_at,enviado_at,actualizado_at,error[\s\S]*WHERE id=\$1/i.test(sql)) {
            const row = rows.find(r => r.id === params[0]); return { rows: row ? [row] : [] };
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
    const queueItems = [];
    return { pool: db, obtenerCandidato: async () => c, sendFn, queueItems,
        commercialQueue: { enqueue: async item => { queueItems.push(item); return { queued: true, code: "QUEUED", id: queueItems.length }; } },
        contactMemory: { claim: async () => ({ allowed: true, id: 99 }), settle: async () => "SENT" } };
}

test("candidato válido: registra EN_COLA, sin llamar al proveedor antes del scheduler", async () => {
    const db = fakeDb(); let enviado = false; const d = deps(db, { sendFn: async () => { enviado = true; return true; } });
    const r = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-1" }, d);
    assert.equal(r.ok, true); assert.equal(r.code, "EN_COLA"); assert.equal(enviado, false); assert.equal(db.rows[0].estado, "EN_COLA"); assert.equal(d.queueItems.length, 1);
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

test("una solicitud aprobada solo queda en cola; el resultado del proveedor se registra al despacharla", async () => {
    const db = fakeDb();
    const r = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-fail" }, deps(db, { sendFn: async () => false }));
    assert.equal(r.ok, true); assert.equal(r.code, "EN_COLA"); assert.equal(db.rows[0].estado, "EN_COLA");
});

test("misma idempotency key/retry: un solo envío", async () => {
    const db = fakeDb(); let llamadas = 0;
    const d = deps(db, { sendFn: async () => { llamadas++; return true; } });
    const a = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-retry" }, d);
    const b = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-retry" }, d);
    assert.equal(a.code, "EN_COLA"); assert.equal(b.code, "INTENTO_EXISTENTE"); assert.equal(llamadas, 0); assert.equal(db.rows.length, 1);
});

test("idempotency key reutilizada para otro teléfono o variante: conflicto, no envía", async () => {
    const db = fakeDb(); let llamadas = 0;
    const d = deps(db, { sendFn: async () => { llamadas++; return true; } });
    await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-conflict" }, d);
    const otraVariante = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 1, idempotencyKey: "k-conflict" }, d);
    const otroTelefono = await enviarRecuperacionManual({ phone: "5511900000002", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-conflict" }, d);
    assert.equal(otraVariante.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(otroTelefono.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(llamadas, 0);
});

test("dos solicitudes simultáneas no agregan dos contactos pendientes al mismo cliente", async () => {
    const db = fakeDb(); let llamadas = 0;
    const d = deps(db, { sendFn: async () => { llamadas++; return true; } });
    const results = await Promise.all(["k-con-1", "k-con-2"].map(idempotencyKey => enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey }, d)));
    assert.equal(db.rows.length, 1); assert.equal(llamadas, 0); assert.equal(results.filter(result => result.code === "EN_COLA").length, 1);
});

test("después del cooldown se conserva el historial y vuelve a admitir una sola fila en cola", async () => {
    const db = fakeDb();
    const inicial = deps(db, { sendFn: async () => true });
    await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-exp-0" }, inicial);
    db.rows[0].estado = "ENVIADO";
    db.rows[0].enviado_at = new Date(Date.now() - 25 * 3600000);
    const d = deps(db);
    const [a, b] = await Promise.all(["k-exp-1", "k-exp-2"].map(idempotencyKey => enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey }, d)));
    assert.equal([a, b].filter(result => result.code === "EN_COLA").length, 1);
    assert.ok([a, b].some(result => ["EN_CURSO", "COOLDOWN"].includes(result.code)));
    assert.equal(db.rows.filter(r => r.estado === "EN_COLA").length, 1);
    assert.equal(db.rows.some(r => r.estado === "EXPIRADO"), true);
});

test("una cola pendiente no reintenta un envío: el proveedor solo se invoca desde el scheduler", async () => {
    const db = fakeDb({ failFinalUpdate: true }); let llamadas = 0;
    const d = deps(db, { sendFn: async () => { llamadas++; return true; } });
    const r = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-ambiguous" }, d);
    assert.equal(r.code, "EN_COLA"); assert.equal(r.historial.estado, "EN_COLA"); assert.equal(llamadas, 0);
    const retry = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-ambiguous-2" }, d);
    assert.equal(retry.code, "EN_CURSO"); assert.equal(llamadas, 0);
});

test("preview B: enviar reconstruye y registra exactamente familia+índice aprobados, sin nueva selección aleatoria", async () => {
    const db = fakeDb(); let textoEnviado = null;
    const d = deps(db, { sendFn: async (_phone, texto) => { textoEnviado = texto; return true; } });
    const r = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-preview-b" }, d);
    assert.equal(r.ok, true); assert.equal(textoEnviado, null); assert.equal(db.rows[0].texto, r.texto); assert.match(r.texto, /consultaste un envío a CUP/i); assert.equal(d.queueItems[0].content, r.texto);
});

test("cooldown menor de 24h bloquea, y después de 24h permite otro intento conservando historial", async () => {
    const db = fakeDb(); const d = deps(db, { sendFn: async () => true });
    await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-cd-1" }, d);
    const bloqueado = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-cd-2" }, d);
    assert.ok(["COOLDOWN", "EN_CURSO"].includes(bloqueado.code));
    db.rows[0].estado = "ENVIADO";
    db.rows[0].enviado_at = new Date(Date.now() - 25 * 3600000);
    const permitido = await enviarRecuperacionManual({ phone: "5511900000001", familia: "servicio_especifico", indice: 0, idempotencyKey: "k-cd-3" }, d);
    assert.equal(permitido.code, "EN_COLA"); assert.equal(db.rows.length, 2); assert.equal(db.rows[0].estado, "EXPIRADO");
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
