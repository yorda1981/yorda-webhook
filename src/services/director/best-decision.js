"use strict";

const pool = require("../../../db");
const env = require("../../config/env");
const llmGateway = require("./llm");
const { conLockExclusivo } = require("../job-lock");

const REVIEW_INTERVAL_MS = 60 * 60 * 1000;
const MIN_CHANGE_ADVANTAGE = 20;
const MIN_IMPACT_LEAD = 10;
const CHANGE_REASONS = new Set([
    "OPORTUNIDAD_SUPERIOR",
    "EVIDENCIA_INVALIDA",
    "NO_EJECUTABLE",
    "CAMBIO_MATERIAL"
]);

const DECISION_SYSTEM = `Eres el Director Comercial de YORDA, un servicio de remesas hacia Cuba.

Debes responder una sola pregunta: con toda la información disponible ahora, ¿cuál es la acción que más ayudará a YORDA a conseguir más clientes o más remesas?

Reglas:
1. Propón una única acción concreta y ejecutable por el operador con los recursos que YORDA ya posee.
2. Usa exclusivamente los HECHOS proporcionados. Cita sus ids en evidenciaIds. No inventes datos ni causas.
3. Distingue la causa probable de la evidencia observada.
4. Si no existe evidencia suficiente, responde SIN_DECISION.
5. Si existe una decisión vigente, protégela. Una alternativa ligeramente mejor no justifica interrumpirla.
6. Solo responde REEMPLAZAR por OPORTUNIDAD_SUPERIOR si la ventaja de cambiar es al menos 20/100 y el impacto de la nueva acción supera claramente el de la vigente.
7. También puedes reemplazar por EVIDENCIA_INVALIDA, NO_EJECUTABLE o CAMBIO_MATERIAL cuando los hechos lo demuestren.
8. Si la decisión vigente sigue siendo suficientemente buena, responde MANTENER.

Devuelve JSON:
{"accion":"CREAR|MANTENER|REEMPLAZAR|RETIRAR|SIN_DECISION","decision":"...","problema":"...","evidenciaIds":["F1"],"causaProbable":"...","justificacion":"...","accionRecomendada":"...","resultadoEsperado":"...","impacto":0,"confianza":0,"ventajaCambio":0,"motivoCambio":"OPORTUNIDAD_SUPERIOR|EVIDENCIA_INVALIDA|NO_EJECUTABLE|CAMBIO_MATERIAL|null","explicacionCambio":"..."}

MANTENER no necesita repetir todos los textos. RETIRAR solo es válido si la decisión vigente perdió validez o dejó de ser ejecutable.`;

const n = value => Number(value) || 0;
const round1 = value => Math.round(n(value) * 10) / 10;

async function collectCommercialSnapshot(db = pool) {
    const result = await db.query(`
        SELECT
            (SELECT COUNT(DISTINCT phone) FROM bot_inbound_messages
             WHERE recibido_at >= NOW() - INTERVAL '24 hours')::int AS conversaciones_24h,
            (SELECT COUNT(DISTINCT phone) / 7.0 FROM bot_inbound_messages
             WHERE recibido_at >= NOW() - INTERVAL '8 days'
               AND recibido_at < NOW() - INTERVAL '24 hours') AS conversaciones_media_7d,
            (SELECT COUNT(*) FROM customers
             WHERE fecha_cotizacion >= NOW() - INTERVAL '24 hours')::int AS cotizaciones_24h,
            (SELECT COUNT(*) / 7.0 FROM customers
             WHERE fecha_cotizacion >= NOW() - INTERVAL '8 days'
               AND fecha_cotizacion < NOW() - INTERVAL '24 hours') AS cotizaciones_media_7d,
            (SELECT COUNT(*) FROM customers
             WHERE estado_crm IN ('cotizado', 'esperando_pix')
               AND fecha_cotizacion >= NOW() - INTERVAL '48 hours')::int AS cotizaciones_sin_cierre_48h,
            (SELECT COUNT(*) FROM customers
             WHERE estado_crm = 'abandono'
               AND updated_at >= NOW() - INTERVAL '7 days')::int AS abandonos_7d,
            (SELECT COUNT(*) FROM operations
             WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS operaciones_24h,
            (SELECT COUNT(*) / 7.0 FROM operations
             WHERE created_at >= NOW() - INTERVAL '8 days'
               AND created_at < NOW() - INTERVAL '24 hours') AS operaciones_media_7d,
            (SELECT COUNT(*) FROM operations
             WHERE completed_at >= NOW() - INTERVAL '24 hours'
               AND status = 'completada')::int AS remesas_24h,
            (SELECT COUNT(*) / 7.0 FROM operations
             WHERE completed_at >= NOW() - INTERVAL '8 days'
               AND completed_at < NOW() - INTERVAL '24 hours'
               AND status = 'completada') AS remesas_media_7d,
            (SELECT COUNT(*) FROM operations
             WHERE status = 'pendiente'
               AND created_at >= NOW() - INTERVAL '48 hours')::int AS operaciones_pendientes_48h,
            (SELECT miembros FROM community_snapshots ORDER BY tomada_at DESC LIMIT 1)::int AS miembros_grupo,
            (SELECT COUNT(*) FILTER (WHERE tipo = 'ALTA') FROM community_member_events
             WHERE ocurrido_at >= NOW() - INTERVAL '24 hours')::int AS altas_grupo_24h,
            (SELECT COUNT(*) FILTER (WHERE tipo = 'BAJA') FROM community_member_events
             WHERE ocurrido_at >= NOW() - INTERVAL '24 hours')::int AS bajas_grupo_24h,
            (SELECT COUNT(*) FROM content_publications
             WHERE estado = 'PUBLICADA' AND publicada_at >= NOW() - INTERVAL '7 days')::int AS publicaciones_7d,
            (SELECT updated_at FROM rates WHERE id = 1) AS tasas_actualizadas_at,
            NOW() AS capturado_at
    `);
    const row = result.rows[0] || {};
    return {
        capturadoAt: row.capturado_at,
        conversaciones24h: n(row.conversaciones_24h),
        conversacionesMedia7d: round1(row.conversaciones_media_7d),
        cotizaciones24h: n(row.cotizaciones_24h),
        cotizacionesMedia7d: round1(row.cotizaciones_media_7d),
        cotizacionesSinCierre48h: n(row.cotizaciones_sin_cierre_48h),
        abandonos7d: n(row.abandonos_7d),
        operaciones24h: n(row.operaciones_24h),
        operacionesMedia7d: round1(row.operaciones_media_7d),
        remesas24h: n(row.remesas_24h),
        remesasMedia7d: round1(row.remesas_media_7d),
        operacionesPendientes48h: n(row.operaciones_pendientes_48h),
        miembrosGrupo: n(row.miembros_grupo),
        altasGrupo24h: n(row.altas_grupo_24h),
        bajasGrupo24h: n(row.bajas_grupo_24h),
        publicaciones7d: n(row.publicaciones_7d),
        tasasActualizadasAt: row.tasas_actualizadas_at || null
    };
}

function snapshotFacts(snapshot) {
    return [
        { id: "F1", dato: `${snapshot.conversaciones24h} personas escribieron al bot en 24 h; media diaria anterior: ${snapshot.conversacionesMedia7d}.` },
        { id: "F2", dato: `${snapshot.cotizaciones24h} clientes cotizaron en 24 h; media diaria anterior: ${snapshot.cotizacionesMedia7d}.` },
        { id: "F3", dato: `${snapshot.cotizacionesSinCierre48h} cotizaciones de las últimas 48 h siguen en cotizado o esperando PIX.` },
        { id: "F4", dato: `${snapshot.abandonos7d} clientes entraron en abandono durante los últimos 7 días.` },
        { id: "F5", dato: `${snapshot.operaciones24h} operaciones se crearon en 24 h; media diaria anterior: ${snapshot.operacionesMedia7d}.` },
        { id: "F6", dato: `${snapshot.remesas24h} remesas se completaron en 24 h; media diaria anterior: ${snapshot.remesasMedia7d}.` },
        { id: "F7", dato: `${snapshot.operacionesPendientes48h} operaciones de las últimas 48 h siguen pendientes.` },
        { id: "F8", dato: `El grupo tiene ${snapshot.miembrosGrupo} miembros; en 24 h hubo ${snapshot.altasGrupo24h} altas y ${snapshot.bajasGrupo24h} bajas.` },
        { id: "F9", dato: `Se publicaron ${snapshot.publicaciones7d} contenidos durante los últimos 7 días.` },
        { id: "F10", dato: `Las tasas vigentes se actualizaron por última vez en ${snapshot.tasasActualizadasAt || "fecha no disponible"}.` }
    ];
}

function mapDecision(row) {
    if (!row) return null;
    return {
        id: Number(row.id), estado: row.estado, decision: row.decision, problema: row.problema,
        evidencia: Array.isArray(row.evidencia) ? row.evidencia : [],
        justificacion: row.justificacion, accionRecomendada: row.accion_recomendada,
        resultadoEsperado: row.resultado_esperado, impacto: Number(row.impacto),
        confianza: Number(row.confianza), sustituyeId: row.sustituye_id ? Number(row.sustituye_id) : null,
        motivoCambio: row.motivo_cambio || null, explicacionCambio: row.explicacion_cambio || null,
        creadaAt: row.creada_at, evaluadaAt: row.evaluada_at, cerradaAt: row.cerrada_at
    };
}

async function getBestDecision(db = pool) {
    const result = await db.query("SELECT * FROM director_decisions WHERE estado = 'VIGENTE' ORDER BY id DESC LIMIT 1");
    return mapDecision(result.rows[0]);
}

const clean = (value, max = 1200) => String(value || "").trim().slice(0, max);
const score = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

function normalizeProposal(data, facts) {
    const action = String(data?.accion || "").toUpperCase();
    const evidenceIds = [...new Set(Array.isArray(data?.evidenciaIds) ? data.evidenciaIds.map(String) : [])];
    const factMap = new Map(facts.map(fact => [fact.id, fact]));
    const evidence = evidenceIds.map(id => factMap.get(id)).filter(Boolean);
    return {
        action,
        decision: clean(data?.decision, 500), problema: clean(data?.problema, 800),
        evidence, causaProbable: clean(data?.causaProbable, 800),
        justificacion: clean(data?.justificacion, 1200),
        accionRecomendada: clean(data?.accionRecomendada, 1200),
        resultadoEsperado: clean(data?.resultadoEsperado, 800),
        impacto: score(data?.impacto), confianza: score(data?.confianza),
        ventajaCambio: score(data?.ventajaCambio),
        motivoCambio: CHANGE_REASONS.has(data?.motivoCambio) ? data.motivoCambio : null,
        explicacionCambio: clean(data?.explicacionCambio, 1000)
    };
}

function validNewDecision(proposal) {
    return proposal.decision && proposal.problema && proposal.evidence.length && proposal.justificacion
        && proposal.accionRecomendada && proposal.resultadoEsperado;
}

function replacementAllowed(current, proposal) {
    if (!proposal.motivoCambio || !proposal.explicacionCambio || !validNewDecision(proposal)) return false;
    if (proposal.motivoCambio !== "OPORTUNIDAD_SUPERIOR") return true;
    return proposal.ventajaCambio >= MIN_CHANGE_ADVANTAGE
        && proposal.impacto >= current.impacto + MIN_IMPACT_LEAD;
}

async function insertDecision(client, proposal, snapshot, current = null) {
    const justification = proposal.causaProbable
        ? `${proposal.justificacion}\n\nCausa probable: ${proposal.causaProbable}`
        : proposal.justificacion;
    const result = await client.query(`
        INSERT INTO director_decisions
            (estado, decision, problema, evidencia, justificacion, accion_recomendada,
             resultado_esperado, impacto, confianza, snapshot, sustituye_id,
             motivo_cambio, explicacion_cambio)
        VALUES ('VIGENTE', $1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
        RETURNING *
    `, [proposal.decision, proposal.problema, JSON.stringify(proposal.evidence), justification,
        proposal.accionRecomendada, proposal.resultadoEsperado, proposal.impacto, proposal.confianza,
        JSON.stringify(snapshot), current?.id || null, proposal.motivoCambio, proposal.explicacionCambio || null]);
    return mapDecision(result.rows[0]);
}

async function applyProposal(db, current, proposal, snapshot) {
    if (current && (proposal.action === "MANTENER" || proposal.action === "SIN_DECISION")) {
        await db.query("UPDATE director_decisions SET evaluada_at = NOW() WHERE id = $1 AND estado = 'VIGENTE'", [current.id]);
        return { decision: { ...current, evaluadaAt: new Date() }, changed: false, reason: "MANTENIDA" };
    }
    if (current && proposal.action === "RETIRAR" && ["EVIDENCIA_INVALIDA", "NO_EJECUTABLE"].includes(proposal.motivoCambio)) {
        await db.query(`UPDATE director_decisions SET estado = 'RETIRADA', motivo_cambio = $2,
                       explicacion_cambio = $3, cerrada_at = NOW(), evaluada_at = NOW()
                       WHERE id = $1 AND estado = 'VIGENTE'`, [current.id, proposal.motivoCambio, proposal.explicacionCambio]);
        return { decision: null, changed: true, reason: proposal.motivoCambio };
    }
    const wantsNew = (!current && proposal.action === "CREAR" && validNewDecision(proposal))
        || (current && proposal.action === "REEMPLAZAR" && replacementAllowed(current, proposal));
    if (!wantsNew) {
        if (current) await db.query("UPDATE director_decisions SET evaluada_at = NOW() WHERE id = $1 AND estado = 'VIGENTE'", [current.id]);
        return { decision: current, changed: false, reason: current ? "ESTABILIDAD" : "SIN_EVIDENCIA" };
    }

    const client = await db.connect();
    try {
        await client.query("BEGIN");
        if (current) {
            await client.query(`UPDATE director_decisions SET estado = 'SUSTITUIDA', cerrada_at = NOW(),
                               evaluada_at = NOW() WHERE id = $1 AND estado = 'VIGENTE'`, [current.id]);
        }
        const decision = await insertDecision(client, proposal, snapshot, current);
        await client.query("COMMIT");
        return { decision, changed: true, reason: current ? proposal.motivoCambio : "PRIMERA_DECISION" };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

async function evaluateBestDecision(dependencies = {}) {
    const db = dependencies.pool || pool;
    const llm = dependencies.llm || llmGateway;
    const snapshot = await collectCommercialSnapshot(db);
    const facts = snapshotFacts(snapshot);
    const current = await getBestDecision(db);
    const user = `HECHOS DISPONIBLES:\n${facts.map(f => `${f.id}. ${f.dato}`).join("\n")}\n\nDECISIÓN VIGENTE:\n${current ? JSON.stringify(current) : "No existe."}`;
    const { data } = await llm.completeJson({ tarea: "decision", system: DECISION_SYSTEM, user, temperature: 0.1 });
    const proposal = normalizeProposal(data, facts);
    return applyProposal(db, current, proposal, snapshot);
}

async function refreshBestDecision(dependencies = {}) {
    const runLocked = dependencies.runLocked || (fn => conLockExclusivo("mejorDecisionDisponible", fn));
    let evaluation = null;
    const ran = await runLocked(async () => { evaluation = await evaluateBestDecision(dependencies); });
    if (evaluation) return evaluation;
    return { decision: await getBestDecision(dependencies.pool || pool), changed: false, reason: ran === false ? "EN_CURSO" : "SIN_CAMBIOS" };
}

async function closeDecision(rawId, action, db = pool) {
    const id = Number(rawId);
    const state = action === "execute" ? "EJECUTADA" : action === "discard" ? "DESCARTADA" : null;
    if (!Number.isSafeInteger(id) || id <= 0 || !state) {
        const error = new Error("Acción o decisión inválida.");
        error.code = "CONTENT_DIRECTOR_VALIDATION";
        throw error;
    }
    const result = await db.query(`UPDATE director_decisions SET estado = $2, cerrada_at = NOW(), evaluada_at = NOW()
                                   WHERE id = $1 AND estado = 'VIGENTE' RETURNING *`, [id, state]);
    return mapDecision(result.rows[0]);
}

function startBestDecision(dependencies = {}) {
    if (!env.DIRECTOR_ENABLED) return null;
    const tick = () => refreshBestDecision(dependencies).catch(error => console.error("❌ Mejor Decisión Disponible:", error.message));
    const first = setTimeout(tick, dependencies.initialDelayMs ?? 5 * 60 * 1000);
    const timer = setInterval(tick, dependencies.intervalMs || REVIEW_INTERVAL_MS);
    for (const handle of [first, timer]) if (typeof handle.unref === "function") handle.unref();
    return { tick, stop: () => { clearTimeout(first); clearInterval(timer); } };
}

module.exports = {
    DECISION_SYSTEM, MIN_CHANGE_ADVANTAGE, MIN_IMPACT_LEAD, collectCommercialSnapshot,
    snapshotFacts, normalizeProposal, replacementAllowed, applyProposal, getBestDecision, evaluateBestDecision,
    refreshBestDecision, closeDecision, startBestDecision
};
