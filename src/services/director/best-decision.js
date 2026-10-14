"use strict";

const pool = require("../../../db");
const env = require("../../config/env");
const llmGateway = require("./llm");
const executionPackages = require("./recovery-execution-package");
const promotionCalculator = require("./promotion-calculator");
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

Investiga la situación comercial y genera al menos tres estrategias que sean diferentes por su mecanismo, no por la redacción. No existe un catálogo cerrado de estrategias: puedes proponer cambios de adquisición, conversión, fidelidad, experiencia, recomendación, operación, confianza, canal u otra posibilidad que surja de los hechos.

Reglas:
1. Usa solo HECHOS con ids; cita los ids en cada estrategia. Distingue hechos de hipótesis y declara datos faltantes.
2. Compara impacto, viabilidad, riesgo, recursos y costos. No inventes importes, margen neto ni costos. Para compromisos económicos sin costos verificados marca requiereCompromisoEconomico=true, ejecutable=false y explica qué falta.
3. El margen aproximado del 5 % es una referencia no verificada, no una autorización para descontar. No inventes ofertas, urgencia, escasez ni beneficios.
3a. Si evalúas una promoción, utiliza solo los escenarios calculados con la tasa vigente incluidos en los hechos. Puedes comparar descuento sobre BRL con mejora porcentual sobre la tasa; no confundas ambos. El costo BRL de mejora es solo una equivalencia, y el margen restante es teórico mientras falten costos reales. No presentes rentabilidad como verificada ni hagas ejecutable una oferta económica sin costos netos comprobados.
4. Las estrategias pueden usar cualquier mecanismo comercial; los recursos disponibles describen integración, no limitan las ideas. Si falta una capacidad, declárala en capacidadesFaltantes y prepara lo que sí sea seguro.
5. Cada estrategia debe incluir trabajo terminado: pasos, materiales concretos, destinatarios/criterio si la evidencia permite seleccionarlos, métricas comerciales y costes conocidos. No envíes ni publiques.
6. Elige una única estrategia ganadora. Una idea creativa sin evidencia suficiente o imposible de ejecutar no debe ganar frente a una opción verificable.
7. Si existe una decisión vigente, protégela: una alternativa ligeramente mejor no la sustituye. Solo REEMPLAZAR por ventaja >=20/100 y mejora clara del impacto, o por EVIDENCIA_INVALIDA, NO_EJECUTABLE o CAMBIO_MATERIAL demostrados.
8. SIN_DECISION solo cuando no exista evidencia suficiente; aun así, devuelve las estrategias exploradas y qué información falta.
9. Usa el registro de métricas antes/después de la decisión vigente para aprender; las variaciones son señales observadas, no prueba causal de que la iniciativa las produjo.
10. En CADA respuesta, también cuando la acción sea MANTENER, devuelve al menos tres alternativas comparables. Deben resolver la oportunidad por mecanismos sustancialmente distintos; cambiar el texto o el segmento de una misma campaña no las hace distintas.

Devuelve JSON:
{"accion":"CREAR|MANTENER|REEMPLAZAR|RETIRAR|SIN_DECISION","estrategiaElegidaId":"S1","alternativas":[{"id":"S1","nombre":"...","mecanismo":"...","problema":"...","evidenciaIds":["F1"],"causaProbable":"...","justificacion":"...","accionRecomendada":"...","resultadoEsperado":"...","impacto":0,"viabilidad":0,"riesgo":0,"confianza":0,"costo":{"tipo":"SIN_COSTO|OPERATIVO|ECONOMICO|DESCONOCIDO","estimacion":null,"baseVerificada":false,"explicacion":"..."},"oferta":{"tipo":"NINGUNA|DESCUENTO_TRANSFERENCIA|MEJORA_TASA","porcentaje":0|1|2},"requiereCompromisoEconomico":false,"ejecutable":true,"recursos":["..."],"pasos":["..."],"destinatarios":{"criterio":"...","basadoEnDatos":true},"materiales":[{"tipo":"biblioteca|whatsapp|bot|otro","titulo":"...","contenido":"..."}],"metricas":["remesas completadas", "ganancia neta"],"capacidadesFaltantes":[]}],"ventajaCambio":0,"motivoCambio":"OPORTUNIDAD_SUPERIOR|EVIDENCIA_INVALIDA|NO_EJECUTABLE|CAMBIO_MATERIAL|null","explicacionCambio":"..."}

RETIRAR solo es válido si la decisión vigente perdió validez o dejó de ser ejecutable.`;

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
            (SELECT COUNT(DISTINCT phone) FROM operations
             WHERE status = 'completada' AND completed_at >= NOW() - INTERVAL '30 days')::int AS clientes_con_remesa_30d,
            (SELECT COUNT(*) FROM customers WHERE cliente_frecuente = TRUE)::int AS clientes_frecuentes,
            (SELECT COUNT(*) FROM customers WHERE COALESCE(nivel_vip, 0) > 0)::int AS clientes_vip,
            (SELECT COALESCE(SUM(monto), 0) FROM operations
             WHERE status = 'completada' AND completed_at >= NOW() - INTERVAL '30 days') AS volumen_remesas_30d,
            (SELECT updated_at FROM rates WHERE id = 1) AS tasas_actualizadas_at,
            FALSE AS costos_unitarios_disponibles,
            FALSE AS ganancia_neta_disponible,
            NOW() AS capturado_at
    `);
    const row = result.rows[0] || {};
    const escenariosPromocion = await promotionCalculator.getCurrentPromotionScenarios(db);
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
        clientesConRemesa30d: n(row.clientes_con_remesa_30d),
        clientesFrecuentes: n(row.clientes_frecuentes),
        clientesVip: n(row.clientes_vip),
        volumenRemesas30d: n(row.volumen_remesas_30d),
        tasasActualizadasAt: row.tasas_actualizadas_at || null,
        rentabilidad: { costosUnitariosDisponibles: false, gananciaNetaDisponible: false },
        escenariosPromocion
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
        { id: "F10", dato: `Las tasas vigentes se actualizaron por última vez en ${snapshot.tasasActualizadasAt || "fecha no disponible"}.` },
        { id: "F11", dato: `${snapshot.clientesConRemesa30d} clientes completaron al menos una remesa en 30 días; ${snapshot.clientesFrecuentes} están marcados como frecuentes y ${snapshot.clientesVip} tienen nivel VIP.` },
        { id: "F12", dato: `El volumen monetario registrado en remesas completadas durante 30 días es ${snapshot.volumenRemesas30d}; es volumen transaccionado, no ganancia.` },
        { id: "F13", dato: `No existe información suficiente de costos unitarios ni ganancia neta por operación; no se puede verificar la rentabilidad de promociones.` },
        { id: "F14", dato: snapshot.escenariosPromocion?.disponible
            ? `Escenarios con tasa vigente de rates (actualizada ${snapshot.escenariosPromocion.updatedAt}; zona São Paulo): ${JSON.stringify(snapshot.escenariosPromocion.escenarios)}. Margen 5 % y restante son referencias teóricas, no rentabilidad neta verificada.`
            : `No se puede calcular ninguna promoción con una tasa vigente: ${snapshot.escenariosPromocion?.motivo || "tasa no disponible"}` }
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
        alternativas: Array.isArray(row.snapshot?.alternativas) ? row.snapshot.alternativas : [],
        estrategiaElegida: row.snapshot?.estrategiaElegida || null,
        snapshot: row.snapshot || {},
        creadaAt: row.creada_at, evaluadaAt: row.evaluada_at, cerradaAt: row.cerrada_at
    };
}

async function getBestDecision(db = pool) {
    const result = await db.query("SELECT * FROM director_decisions WHERE estado = 'VIGENTE' ORDER BY id DESC LIMIT 1");
    return mapDecision(result.rows[0]);
}

const clean = (value, max = 1200) => String(value || "").trim().slice(0, max);
const score = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

function mechanismsAreDistinct(alternatives) {
    const stopWords = new Set(["para", "con", "por", "del", "las", "los", "una", "uno", "desde", "mediante", "sobre", "the", "and"]);
    const tokens = alternatives.map(item => new Set(clean(item.mecanismo, 240).toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9]+/g)
        ?.filter(token => token.length > 2 && !stopWords.has(token)) || []));
    for (let i = 0; i < tokens.length; i += 1) {
        for (let j = i + 1; j < tokens.length; j += 1) {
            const union = new Set([...tokens[i], ...tokens[j]]);
            const intersection = [...tokens[i]].filter(token => tokens[j].has(token)).length;
            if (!union.size || intersection / union.size >= 0.65) return false;
        }
    }
    return true;
}

function commercialOutcomeMetrics(snapshot) {
    return {
        conversaciones24h: snapshot.conversaciones24h,
        cotizaciones24h: snapshot.cotizaciones24h,
        remesasCompletadas24h: snapshot.remesas24h,
        remesasCompletadas30d: snapshot.clientesConRemesa30d,
        volumenRemesas30d: snapshot.volumenRemesas30d
    };
}

function withOutcomeObservation(snapshot, current = null, alternatives = [], selectedStrategy = null) {
    const currentMetrics = commercialOutcomeMetrics(snapshot);
    const base = current?.snapshot?.metricasBase || currentMetrics;
    const previous = current?.snapshot?.observacionesResultado || [];
    const deltas = Object.fromEntries(["conversaciones24h", "cotizaciones24h", "remesasCompletadas24h"]
        .map(key => [key, n(currentMetrics[key]) - n(base[key])]));
    const observation = { capturadoAt: snapshot.capturadoAt || new Date().toISOString(), metricas: currentMetrics, variacionDesdeDecision: deltas,
        nota: "Cambio observado respecto al inicio; no atribuye causalidad a la estrategia." };
    return { ...snapshot, alternativas: alternatives, estrategiaElegida: selectedStrategy,
        metricasBase: base, observacionesResultado: [...previous, observation].slice(-24) };
}

function normalizeProposal(data, facts, promotionContext = null) {
    const action = String(data?.accion || "").toUpperCase();
    const evidenceIds = [...new Set(Array.isArray(data?.evidenciaIds) ? data.evidenciaIds.map(String) : [])];
    const factMap = new Map(facts.map(fact => [fact.id, fact]));
    const evidence = evidenceIds.map(id => factMap.get(id)).filter(Boolean);
    const alternatives = (Array.isArray(data?.alternativas) ? data.alternativas : []).slice(0, 6).map((item, index) => {
        const ids = [...new Set(Array.isArray(item?.evidenciaIds) ? item.evidenciaIds.map(String) : [])];
        const evidence = ids.map(id => factMap.get(id)).filter(Boolean);
        const costType = ["SIN_COSTO", "OPERATIVO", "ECONOMICO", "DESCONOCIDO"].includes(item?.costo?.tipo)
            ? item.costo.tipo : "DESCONOCIDO";
        // No hay una fuente estructurada de costos en los datos actuales. Una
        // afirmación del modelo o una cita de actividad comercial no verifica un costo.
        const verifiedCost = false;
        const strategyText = [item?.nombre, item?.accionRecomendada, item?.justificacion,
            ...(Array.isArray(item?.pasos) ? item.pasos : []),
            ...(Array.isArray(item?.materiales) ? item.materiales.map(material => `${material?.titulo || ""} ${material?.contenido || ""}`) : [])]
            .join(" ");
        const economicLanguage = /\b(descuento|bono|bonificación|tasa preferencial|entrega gratis|gratis|crédito|cashback|incentivo|premio|regalo|promoción económica)\b|(?:R\$|\$)\s?\d/i.test(strategyText);
        const requiresMoney = Boolean(item?.requiereCompromisoEconomico) || economicLanguage || costType === "ECONOMICO";
        const offerType = ["DESCUENTO_TRANSFERENCIA", "MEJORA_TASA"].includes(String(item?.oferta?.tipo || "").toUpperCase())
            ? String(item.oferta.tipo).toUpperCase() : "NINGUNA";
        const offerPercent = [1, 2].includes(Number(item?.oferta?.porcentaje)) ? Number(item.oferta.porcentaje) : 0;
        const offer = offerType === "NINGUNA" ? null : { tipo: offerType, porcentaje: offerPercent };
        const promotionScenarios = offer ? promotionCalculator.findOfferScenario(promotionContext, offer) : [];
        const isRateOffer = Boolean(offer);
        const promotionCostEstimate = promotionScenarios.length
            ? promotionScenarios.map(scenario => ({ transferenciaBRL: scenario.importeTransferenciaBRL, costoBeneficioBRL: scenario.costoBeneficioBRL,
                margenReferenciaRestanteBRL: scenario.margenReferenciaRestanteBRL, margenReferenciaRestantePct: scenario.margenReferenciaRestantePct })) : null;
        const costPenalty = costType === "SIN_COSTO" ? 0
            : costType === "OPERATIVO" ? 8
                : verifiedCost ? 12 : 22;
        const strategy = {
            id: clean(item?.id, 12) || `S${index + 1}`,
            nombre: clean(item?.nombre, 180), mecanismo: clean(item?.mecanismo, 240),
            problema: clean(item?.problema, 600), evidencia: evidence, causaProbable: clean(item?.causaProbable, 600),
            justificacion: clean(item?.justificacion, 800), accionRecomendada: clean(item?.accionRecomendada, 1000),
            resultadoEsperado: clean(item?.resultadoEsperado, 600),
            impacto: score(item?.impacto), viabilidad: score(item?.viabilidad), riesgo: score(item?.riesgo),
            confianza: score(item?.confianza), costo: {
                tipo: isRateOffer ? "ECONOMICO" : costType,
                estimacion: verifiedCost ? Number(item.costo.estimacion) : promotionCostEstimate,
                baseVerificada: verifiedCost, explicacion: isRateOffer
                    ? (promotionCostEstimate ? "Estimación del beneficio calculada con la tasa vigente; no es costo neto de liquidación. El margen restante usa la referencia no verificada del 5 %." : "Cálculo pendiente: no hay una tasa diaria vigente válida.")
                    : clean(item?.costo?.explicacion, 400)
            },
            oferta: offer,
            simulacionPromocion: promotionScenarios,
            requiereCompromisoEconomico: requiresMoney || isRateOffer,
            penalizacionCosto: costPenalty,
            ejecutable: Boolean(item?.ejecutable) && !requiresMoney,
            recursos: (Array.isArray(item?.recursos) ? item.recursos : []).map(value => clean(value, 120)).filter(Boolean).slice(0, 8),
            pasos: (Array.isArray(item?.pasos) ? item.pasos : []).map(value => clean(value, 400)).filter(Boolean).slice(0, 12),
            destinatarios: { criterio: clean(item?.destinatarios?.criterio, 400), basadoEnDatos: Boolean(item?.destinatarios?.basadoEnDatos) },
            materiales: (Array.isArray(item?.materiales) ? item.materiales : []).slice(0, 8).map(asset => ({
                tipo: clean(asset?.tipo, 40), titulo: clean(asset?.titulo, 180), contenido: clean(asset?.contenido, 4000)
            })),
            metricas: (Array.isArray(item?.metricas) ? item.metricas : []).map(value => clean(value, 160)).filter(Boolean).slice(0, 8),
            capacidadesFaltantes: (Array.isArray(item?.capacidadesFaltantes) ? item.capacidadesFaltantes : []).map(value => clean(value, 240)).filter(Boolean).slice(0, 8)
        };
        strategy.puntuacionComercial = Math.max(0, Math.min(100, Math.round(
            strategy.impacto * 0.35 + strategy.viabilidad * 0.35 + strategy.confianza * 0.3
            - strategy.riesgo * 0.2 - strategy.penalizacionCosto
        )));
        if (!strategy.evidencia.length || (isRateOffer && (!promotionScenarios.length || !verifiedCost))) strategy.ejecutable = false;
        if (strategy.ejecutable && (!strategy.pasos.length || !strategy.accionRecomendada)) strategy.ejecutable = false;
        return strategy;
    }).filter(item => item.nombre && item.mecanismo);
    const selectedId = clean(data?.estrategiaElegidaId, 12);
    const ranked = [...alternatives].sort((a, b) => Number(b.ejecutable) - Number(a.ejecutable)
        || b.puntuacionComercial - a.puntuacionComercial);
    const modelSelected = alternatives.find(item => item.id === selectedId) || null;
    const selectedStrategy = (modelSelected?.ejecutable ? modelSelected : null)
        || ranked.find(item => item.ejecutable) || modelSelected || ranked[0] || null;
    const decisionData = selectedStrategy || data;
    return {
        action,
        decision: clean(decisionData?.decision || decisionData?.nombre, 500), problema: clean(decisionData?.problema, 800),
        evidence: selectedStrategy ? selectedStrategy.evidencia : evidence,
        causaProbable: clean(decisionData?.causaProbable, 800),
        justificacion: clean(decisionData?.justificacion, 1200),
        accionRecomendada: clean(decisionData?.accionRecomendada, 1200),
        resultadoEsperado: clean(decisionData?.resultadoEsperado, 800),
        impacto: score(decisionData?.impacto), confianza: score(decisionData?.confianza),
        ventajaCambio: score(data?.ventajaCambio),
        motivoCambio: CHANGE_REASONS.has(data?.motivoCambio) ? data.motivoCambio : null,
        explicacionCambio: clean(data?.explicacionCambio, 1000),
        alternatives, selectedStrategy,
        alternativesValid: alternatives.length >= 3 && mechanismsAreDistinct(alternatives)
    };
}

async function generateCommercialProposal(llm, user, facts, promotionContext = null) {
    const first = await llm.completeJson({ tarea: "decision", system: DECISION_SYSTEM, user, temperature: 0.1 });
    let proposal = normalizeProposal(first.data, facts, promotionContext);
    if (proposal.alternativesValid) return proposal;
    const retryUser = `${user}\n\nTU RESPUESTA ANTERIOR NO CUMPLIÓ EL CRITERIO DE COMPARACIÓN. Rehazla completa: entrega al menos tres mecanismos realmente distintos, cita evidencia disponible para cada uno y vuelve a elegir la mejor. No conviertas variaciones de copy o segmentos en estrategias distintas.`;
    const retry = await llm.completeJson({ tarea: "decision", system: DECISION_SYSTEM, user: retryUser, temperature: 0.1 });
    proposal = normalizeProposal(retry.data, facts, promotionContext);
    return proposal;
}

function validNewDecision(proposal) {
    return proposal.alternativesValid && proposal.decision && proposal.problema && proposal.evidence.length && proposal.justificacion
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
        JSON.stringify(withOutcomeObservation(snapshot, null, proposal.alternatives, proposal.selectedStrategy)),
        current?.id || null, proposal.motivoCambio, proposal.explicacionCambio || null]);
    return mapDecision(result.rows[0]);
}

async function applyProposal(db, current, proposal, snapshot) {
    if (current && (proposal.action === "MANTENER" || proposal.action === "SIN_DECISION")) {
        const observedSnapshot = withOutcomeObservation(snapshot, current, proposal.alternatives, proposal.selectedStrategy);
        await db.query("UPDATE director_decisions SET evaluada_at = NOW(), snapshot = $2::jsonb WHERE id = $1 AND estado = 'VIGENTE'", [current.id,
            JSON.stringify(observedSnapshot)]);
        return { decision: { ...current, alternativas: proposal.alternatives, estrategiaElegida: proposal.selectedStrategy,
            snapshot: observedSnapshot, evaluadaAt: new Date() }, changed: false, reason: "MANTENIDA" };
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
    const executionPackage = current ? await executionPackages.getPackageForDecision(current.id, db) : null;
    const executionFeedback = executionPackage ? {
        tipo: executionPackage.tipo, estado: executionPackage.estado,
        señalesOperador: executionPackage.contenido?.señalesOperador || [],
        resultados: executionPackage.contenido?.ejecucion?.resultados || [],
        remesasOContactosEjecutados: executionPackage.contenido?.ejecucion?.completados ?? null,
        activosBibliotecaCreados: executionPackage.contenido?.ejecucion?.activosBiblioteca || []
    } : null;
    const user = `HECHOS DISPONIBLES:\n${facts.map(f => `${f.id}. ${f.dato}`).join("\n")}\n\nESCENARIOS DE OFERTAS CON TASA REAL (úsalos solo si están disponibles; son estimaciones, no rentabilidad comprobada):\n${JSON.stringify(snapshot.escenariosPromocion)}\n\nDECISIÓN VIGENTE Y MÉTRICAS OBSERVADAS:\n${current ? JSON.stringify(current) : "No existe."}\n\nSEÑALES DE REVISIÓN/EJECUCIÓN DEL OPERADOR:\n${JSON.stringify(executionFeedback)}`;
    const proposal = await generateCommercialProposal(llm, user, facts, snapshot.escenariosPromocion);
    if (!proposal.alternativesValid) {
        return { decision: current, changed: false, reason: "ALTERNATIVAS_INSUFICIENTES",
            alternativas: proposal.alternatives, executionPackage };
    }
    const result = await applyProposal(db, current, proposal, snapshot);
    if (result.decision) {
        result.executionPackage = await executionPackages.ensureCommercialPackage(result.decision, db, dependencies);
    }
    return result;
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
    snapshotFacts, commercialOutcomeMetrics, withOutcomeObservation, mechanismsAreDistinct, mapDecision, normalizeProposal,
    generateCommercialProposal, replacementAllowed, applyProposal, getBestDecision, evaluateBestDecision,
    refreshBestDecision, closeDecision, startBestDecision
};
