"use strict";

const { createHash } = require("node:crypto");
const pool = require("../../../db");
const env = require("../../config/env");
const contentLibrary = require("../content-library");
const contentScheduler = require("../content-scheduler");
const contentDestinations = require("../content-destinations");
const customerAcquisition = require("../customer-acquisition");
const commercialFunnel = require("../commercial-funnel");
const directorConfig = require("./director-config");
const llmGateway = require("./llm");
const { fechaSaoPaulo, saoPauloLocalAUTC } = require("../../utils/timezone");

const TIME_ZONE = "America/Sao_Paulo";
const GROUP = "comercial";
const MAX_PROMOTIONS_PER_DAY = 1;
const POLICY_VERSION = "commercial-auto-v1";
const CATEGORY_NAMES = Object.freeze({
    "como-utilizar-yorda": "Cómo utilizar YORDA",
    captacion: "Captación de clientes",
    referidos: "Programa de referidos",
    "preguntas-frecuentes": "Preguntas frecuentes",
    confianza: "Confianza y transparencia",
    "opciones-recepcion": "Opciones de recepción"
});

const FACTS = Object.freeze({
    "como-utilizar-yorda": [
        { id: "quote_amount", text: "Puedes pedir una cotización escribiendo al bot el monto que quieres enviar; también puedes decir que quieres enviar y el bot te preguntará el monto." },
        { id: "quote_accept", text: "Después de revisar la cotización, puedes confirmar si quieres continuar." },
        { id: "pix_steps", text: "Al confirmar, el bot envía los datos para pagar por PIX; después puedes enviar el comprobante en el mismo chat." },
        { id: "operation_updates", text: "El bot informa cuando la operación queda confirmada, completada o cancelada." }
    ],
    captacion: [
        { id: "service", text: "YORDA ayuda a enviar dinero a Cuba. Puedes iniciar una cotización escribiendo al bot oficial cuánto quieres enviar." },
        { id: "quote_choices", text: "Puedes pedir una cotización para saber cuánto recibiría tu familia antes de decidir si continúas." }
    ],
    "preguntas-frecuentes": [
        { id: "quote_current", text: "El bot calcula la cotización cuando la solicitas; si cambió el día o venció, puedes pedir una nueva." },
        { id: "proof_review", text: "Recibir un comprobante no significa que el pago ya esté confirmado; una persona lo revisa antes de procesarlo." },
        { id: "pix_steps", text: "Al confirmar, el bot envía los datos para pagar por PIX; después puedes enviar el comprobante en el mismo chat." },
        { id: "operation_updates", text: "El bot informa cuando la operación queda confirmada, completada o cancelada." },
        { id: "human_help", text: "Si el bot no entiende una consulta, ofrece hablar con una persona." }
    ],
    confianza: [
        { id: "proof_review", text: "Recibir un comprobante no significa que el pago esté confirmado; una persona lo revisa antes de procesarlo." },
        { id: "operation_updates", text: "El bot informa cuando la operación queda confirmada, completada o cancelada." },
        { id: "human_help", text: "Si el bot no entiende una consulta, ofrece hablar con una persona." }
    ]
});

const SAFE_HOOK_BANNED = /(?:garantiz\w*|seguridad absoluta|100\s*%|instant[aá]ne\w*|en minutos|entrega inmediata|sin riesgo|sin comisi[oó]n|descuento|bonificaci[oó]n|gratis|solo por hoy|[uú]ltima oportunidad|aprovecha antes|tasa especial|mejor tasa|te pagamos|ganancia segura|testimonio|cliente dijo|n[uú]mero uno)/i;

function marketerError(message, status = 400) {
    return Object.assign(new Error(message), { status, code: "DIRECTOR_MARKETER_VALIDATION" });
}

function isActiveReferralConfig(config, now) {
    return Boolean(config?.enabled && config?.expires_at && new Date(config.expires_at).getTime() > now.getTime());
}

function referralBudget(config, summary) {
    const cap = Math.min(Number(config?.campaign_limit_brl || config?.period_limit_brl || 0), Number(config?.period_limit_brl || 0));
    const committed = Number(summary?.costo_comprometido_brl || 0);
    return { cap, committed, available: Math.max(0, Math.round((cap - committed) * 100) / 100) };
}

function assertSafeHook(hook) {
    const value = String(hook || "").trim();
    if (value.length < 15 || value.length > 150 || !value.endsWith("?")) {
        throw marketerError("La apertura no es una pregunta breve aprobable.", 422);
    }
    if (/\d|https?:\/\/|www\.|wa\.me|\+\d|(?:R\$|BRL|CUP|USD|MLC)\s*\d/i.test(value)) {
        throw marketerError("La apertura contiene cifras, valores o enlaces no permitidos.", 422);
    }
    if (SAFE_HOOK_BANNED.test(value)) throw marketerError("La apertura incluye una promesa o promoción no autorizada.", 422);
    if (!/^¿(?:quieres|te gustaría|tienes dudas|sabes cómo|cómo puedes|te interesa|necesitas|quieres saber|te gustaría saber)\b/i.test(value)) {
        throw marketerError("La apertura debe ser una pregunta neutral sin afirmaciones comerciales no verificadas.", 422);
    }
    return value;
}

const STOP_WORDS = new Set("a al algo como con cual cuando de del donde el ella en entre es esta este estos la las le les lo los más me mi muy no o para pero por que se sin su sus te tu un una uno unos unas y ya quieres cómo".split(" "));

function similarityTokens(text) {
    return new Set(String(text || "").toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(token => token.length > 2 && !STOP_WORDS.has(token)));
}

function tokenSimilarity(left, right) {
    const a = similarityTokens(left), b = similarityTokens(right);
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const token of a) if (b.has(token)) shared++;
    return shared / (a.size + b.size - shared);
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
}

async function findRecentSimilarContent(body, db) {
    const recent = await db.query(`SELECT cr.cuerpo FROM content_items ci
        JOIN LATERAL (SELECT cuerpo FROM content_revisions WHERE content_item_id=ci.id ORDER BY numero DESC LIMIT 1) cr ON TRUE
        WHERE ci.grupo=$1 AND ci.creado_at>=NOW()-INTERVAL '30 days'`, [GROUP]);
    return recent.rows.find(row => tokenSimilarity(body, row.cuerpo) >= 0.62) || null;
}

function marketerSchema(facts) {
    return {
        type: "object", additionalProperties: false,
        properties: {
            gancho: { type: "string" },
            hechosUsados: { type: "array", items: { type: "string", enum: facts.map(fact => fact.id) } },
            aporte: { type: "string" }
        },
        required: ["gancho", "hechosUsados", "aporte"]
    };
}

function buildPrompt(category, facts, objective) {
    return [
        `Categoría autorizada: ${CATEGORY_NAMES[category]}.`,
        `Objetivo comercial respaldado: ${objective.reason}.`,
        "Crea una apertura variada en forma de pregunta (15–150 caracteres) y elige entre uno y tres hechos usando únicamente sus identificadores.",
        "La apertura no puede afirmar hechos, incluir cifras, tasas, monedas, links, descuentos, garantías, urgencia ni testimonios. El código añadirá literalmente los hechos y la llamada a la acción.",
        "No escribas el texto completo de la publicación. No añadas condiciones ni ventajas. Explica brevemente el aporte comercial.",
        `HECHOS VERIFICADOS: ${JSON.stringify(facts.map(({ id, text }) => ({ id, text })))}`
    ].join("\n");
}

function buildCategoryContent(category, hook, facts, selectedIds, extra = {}) {
    const selected = [...new Set(selectedIds)].map(id => facts.find(fact => fact.id === id)).filter(Boolean);
    if (!selected.length || selected.length > 3) throw marketerError("La IA no seleccionó hechos verificables suficientes.", 422);
    const lines = [`*${CATEGORY_NAMES[category]}*`, hook, ...selected.map(fact => fact.text)];
    if (category === "referidos") {
        const { config, budget } = extra;
        if (!config || budget.available < Number(config.max_reward_brl || 0)) throw marketerError("El programa de referidos no tiene presupuesto suficiente para admitir otra participación.", 409);
        const expiry = new Intl.DateTimeFormat("es-BR", { dateStyle: "short", timeZone: TIME_ZONE }).format(new Date(config.expires_at));
        lines.push(`Recompensa configurada: ${Number(config.reward_pct)} % de la primera remesa válida del referido, con un máximo de R$ ${Number(config.max_reward_brl).toFixed(2)}. Programa vigente hasta ${expiry}, sujeto al presupuesto disponible y a la validación de la operación.`);
        lines.push("Pide al bot tu enlace personal para compartirlo.");
    } else {
        lines.push("¿Quieres consultar una cotización o resolver una duda? Escríbenos por privado al bot oficial de YORDA.");
    }
    const body = lines.join("\n\n");
    if (body.length < 180 || body.length > 1500) throw marketerError("La publicación queda fuera del rango de longitud permitido.", 422);
    if (/https?:\/\/|www\.|wa\.me|\+\d{5,}/i.test(body)) throw marketerError("La publicación contiene un enlace o teléfono no validado.", 422);
    return { body, factIds: selected.map(fact => fact.id) };
}

async function loadCategoryFacts(category, db = pool, now = new Date(), dependencies = {}) {
    if (category === "referidos") {
        const acquisition = dependencies.acquisition || customerAcquisition;
        const [config, summary] = await Promise.all([
            acquisition.getProgramConfig(db), acquisition.getReferralSummary(db)
        ]);
        const budget = referralBudget(config, summary);
        if (!isActiveReferralConfig(config, now) || Number(config.max_reward_brl || 0) <= 0
            || budget.available < Number(config.max_reward_brl || 0)) {
            return { available: false, reason: "Programa inactivo, vencido o con presupuesto insuficiente para reservar una recompensa máxima." };
        }
        const facts = [{ id: "share_personal_link", text: "Cada cliente puede solicitar al bot su enlace personal y compartirlo con una persona nueva." }];
        return { available: true, facts, referral: { config, budget } };
    }
    if (category === "opciones-recepcion") {
        const result = await db.query("SELECT brl_0, usd1, usd2, mlc, efectivo FROM rates WHERE id = 1");
        const row = result.rows[0] || {};
        const modes = [];
        if (Number(row.brl_0) > 0) modes.push("CUP a tarjeta");
        if (Number(row.usd1) > 0 || Number(row.usd2) > 0) modes.push("USD a tarjeta");
        if (Number(row.mlc) > 0) modes.push("MLC a tarjeta");
        if (Number(row.efectivo) > 0) modes.push("entrega en efectivo");
        if (!modes.length) return { available: false, reason: "No hay modalidades de recepción verificables en las tasas actuales." };
        const facts = modes.map((text, index) => ({ id: `mode_${index + 1}`, text: `La configuración actual contempla ${text}.` }));
        return { available: true, facts, offeringSnapshot: modes };
    }
    const facts = FACTS[category];
    return facts?.length ? { available: true, facts: [...facts], sourceVersion: dependencies.manual?.version || "manual-proceso" }
        : { available: false, reason: "La categoría no dispone de hechos verificados." };
}

async function getDestination(dependencies, db) {
    const destinations = dependencies.destinations || contentDestinations;
    const destination = await destinations.getDefaultDestination(db);
    if (!destination || destination.type !== "WHATSAPP_GROUP" || !destination.active || !destination.validatedAt) {
        return null;
    }
    return destination;
}

async function hasPromoForDay(db, date) {
    const result = await db.query(`
        SELECT EXISTS (
            SELECT 1 FROM content_schedules cs JOIN content_items ci ON ci.id = cs.content_item_id
            WHERE ci.grupo = $1 AND (cs.programada_para AT TIME ZONE $2)::date = $3::date
            UNION ALL
            SELECT 1 FROM content_publications cp JOIN content_items ci ON ci.id = cp.content_item_id
            WHERE ci.grupo = $1 AND cp.publicada_at IS NOT NULL
              AND (cp.publicada_at AT TIME ZONE $2)::date = $3::date
        ) AS exists
    `, [GROUP, TIME_ZONE, date]);
    return result.rows[0]?.exists === true;
}

async function selectObjective(db, available, now, dependencies = {}) {
    const funnel = await (dependencies.funnel || commercialFunnel).obtenerResumen(30, db).catch(() => ({}));
    if (Number(funnel.sin_avance_observable_24h || 0) > 0) {
        const preferred = ["preguntas-frecuentes", "como-utilizar-yorda"].find(category => available.includes(category));
        if (preferred) return { category: preferred, reason: `${funnel.sin_avance_observable_24h} cotización(es) sin avance observable durante 24 horas; se prioriza aclarar el siguiente paso sin contactar clientes.` };
    }
    const recent = await db.query(`
        SELECT categoria, MAX(creado_at) AS ultimo
        FROM content_items WHERE grupo = $1 AND creado_at >= NOW() - INTERVAL '30 days'
        GROUP BY categoria
    `, [GROUP]);
    const last = new Map(recent.rows.map(row => [row.categoria, new Date(row.ultimo).getTime()]));
    const category = [...available].sort((a, b) => (last.get(a) || 0) - (last.get(b) || 0) || a.localeCompare(b))[0];
    return category ? { category, reason: "Rotación por menor uso reciente entre categorías comerciales disponibles; no existe evidencia suficiente para atribuir conversiones a una categoría." } : null;
}

async function recordEvent(db, contentId, eventType, data, actor = "marketer_policy") {
    await db.query(`INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
        VALUES ('CONTENT_ITEM',$1,$2,$3,$4::jsonb)`, [contentId, eventType, actor, JSON.stringify(data || {})]);
}

async function runDaily({ db = pool, now = new Date(), marketerConfig = null, manual = null } = {}, dependencies = {}) {
    const configService = dependencies.config || directorConfig;
    const cfg = marketerConfig || (await configService.getActiveConfig(db)).marketer;
    if (!cfg?.enabled) return { status: "DESACTIVADO" };
    const destination = await getDestination(dependencies, db);
    if (!destination) return { status: "RECHAZADO", reason: "No hay un grupo de WhatsApp activo y validado." };
    const date = fechaSaoPaulo(now);
    const scheduledAt = saoPauloLocalAUTC(`${date}T${cfg.time}`);
    if (!scheduledAt || scheduledAt.getTime() <= now.getTime()) return { status: "SIN_PUBLICACION", reason: "El horario promocional de hoy ya pasó; no se recuperan publicaciones atrasadas." };
    if (await hasPromoForDay(db, date)) return { status: "SIN_PUBLICACION", reason: "Ya existe una publicación comercial programada o publicada hoy." };

    const systemKey = `marketer-${date}`;
    const prior = await db.query("SELECT id,estado FROM content_items WHERE origen_sistema=$1 LIMIT 1", [systemKey]);
    if (prior.rows[0]) return { status: "SIN_PUBLICACION", reason: "El objetivo editorial de hoy ya se procesó.", contentId: Number(prior.rows[0].id) };

    const configured = Array.isArray(cfg.categories) ? cfg.categories.filter(category => directorConfig.MARKETER_CATEGORIES.includes(category)) : [];
    const factsByCategory = new Map();
    for (const category of configured) {
        const loaded = await loadCategoryFacts(category, db, now, { ...dependencies, manual });
        if (loaded.available) factsByCategory.set(category, loaded);
    }
    if (!factsByCategory.size) return { status: "SIN_PUBLICACION", reason: "Ninguna categoría habilitada tiene hechos comerciales verificables ahora." };
    const objective = await selectObjective(db, [...factsByCategory.keys()], now, dependencies);
    if (!objective) return { status: "SIN_PUBLICACION", reason: "No hay objetivo editorial disponible." };

    const facts = factsByCategory.get(objective.category).facts;
    const llm = dependencies.llm || llmGateway;
    let data;
    try {
        ({ data } = await llm.completeJson({
            tarea: "redaccion", system: "Eres el redactor comercial de YORDA. Solo puedes crear una apertura interrogativa y seleccionar hechos por ID. No apruebas ni publicas contenido.",
            user: buildPrompt(objective.category, facts, objective), temperature: 0.4,
            contextMetrics: { marketerCategory: objective.category, verifiedFacts: facts.length, clientRows: 0, operationRows: 0, fullConversationMessages: 0 },
            responseSchema: marketerSchema(facts)
        }));
    } catch (error) {
        return { status: "RECHAZADO", category: objective.category, code: error.code || "MARKETER_GENERATION_FAILED",
            reason: `La respuesta generativa no superó el esquema estricto: ${String(error.message || error).slice(0, 200)}` };
    }
    const validationErrors = [];
    const rawHook = String(data?.gancho || "").trim();
    let hook = rawHook;
    try { hook = assertSafeHook(rawHook); }
    catch (error) { validationErrors.push(error.message); hook = "¿Quieres conocer mejor este proceso?"; }
    const requestedIds = Array.isArray(data?.hechosUsados) ? data.hechosUsados : [];
    const validIds = [...new Set(requestedIds)].filter(id => facts.some(fact => fact.id === id)).slice(0, 3);
    if (!validIds.length) validationErrors.push("La IA no seleccionó hechos comerciales verificables.");
    if (requestedIds.length > 3) validationErrors.push("La propuesta seleccionó más de tres hechos.");
    const bodyResult = buildCategoryContent(objective.category, hook, facts, validIds.length ? validIds : [facts[0].id], factsByCategory.get(objective.category).referral);
    const aporte = String(data?.aporte || "").trim().slice(0, 600);
    if (aporte.length < 20) validationErrors.push("La IA no explicó el aporte comercial.");
    const proposal = { ...bodyResult, aporte: aporte.length >= 20 ? aporte : `Contenido comercial basado en hechos verificados para ${CATEGORY_NAMES[objective.category]}.` };

    const similar = await findRecentSimilarContent(proposal.body, db);
    if (similar) validationErrors.push("El contenido es demasiado parecido a otra pieza comercial de los últimos 30 días.");

    const loaded = factsByCategory.get(objective.category);
    const metadata = {
        policyVersion: POLICY_VERSION, category: objective.category, manualVersion: loaded.sourceVersion || null,
        facts: loaded.facts.filter(fact => proposal.factIds.includes(fact.id)),
        referral: loaded.referral ? {
            enabled: true, rewardPct: Number(loaded.referral.config.reward_pct), maxRewardBRL: Number(loaded.referral.config.max_reward_brl),
            budgetBRL: loaded.referral.budget.cap, availableBRL: loaded.referral.budget.available,
            expiresAt: loaded.referral.config.expires_at
        } : null,
        offeringSnapshot: loaded.offeringSnapshot || null
    };
    const library = dependencies.library || contentLibrary;
    let asset;
    try {
        asset = await library.createDirectorDraft({
            titulo: CATEGORY_NAMES[objective.category], cuerpo: proposal.body, aporte: proposal.aporte,
            grupo: GROUP, categoria: objective.category,
            impacto: { fuente: "resumen_funnel_y_rotacion", objetivo: objective.reason },
            fuentes: [{ nombre: "Hechos comerciales verificados de YORDA", titulo: `${POLICY_VERSION} · ${objective.category}`,
                url: "internal://yorda-marketer", datosVerificados: metadata }],
            origenSistema: systemKey
        }, db);
    } catch (error) {
        return { status: "RECHAZADO", category: objective.category, reason: `No se pudo guardar en la Biblioteca: ${String(error.message || error).slice(0, 200)}` };
    }

    // La clave diaria hace idempotente la inserción, pero una segunda instancia
    // podría encontrar un borrador creado concurrentemente. Nunca autorizarlo
    // usando la respuesta de IA de la otra instancia: comparar lo persistido.
    asset = await library.getContentAsset(asset.id, db);
    const storedEvidence = asset?.fuentes?.find(source => source.datosVerificados)?.datosVerificados;
    const expectedEvidence = metadata;
    if (!asset || asset.estado !== "BORRADOR" || asset.cuerpo !== proposal.body || asset.grupo !== GROUP
        || asset.categoria !== objective.category || asset.origenSistema !== systemKey
        || stableJson(storedEvidence) !== stableJson(expectedEvidence)) {
        return { status: "SIN_PUBLICACION", contentId: asset?.id || null, category: objective.category,
            reason: "El borrador persistido difiere de la propuesta que acaba de validar el Director; queda sin autorización automática." };
    }

    if (validationErrors.length) {
        const reason = validationErrors.join(" ").slice(0, 600);
        await recordEvent(db, asset.id, "CONTENT_MARKETER_REJECTED", {
            policyVersion: POLICY_VERSION, category: objective.category, reason,
            factsUsed: proposal.factIds, status: "BORRADOR_PENDIENTE_REVISION"
        });
        return { status: "RECHAZADO", contentId: asset.id, category: objective.category, reason };
    }

    await recordEvent(db, asset.id, "CONTENT_MARKETER_VALIDATED", {
        policyVersion: POLICY_VERSION, category: objective.category, objective: objective.reason,
        factsUsed: proposal.factIds, revisionId: asset.revisionId,
        bodyHash: createHash("sha256").update(asset.cuerpo).digest("hex"),
        destinationId: destination.destinationId, timeZone: TIME_ZONE
    });
    const approval = await library.resolveDraft(asset.id, "approve", db, "marketer_policy");
    if (!approval.changed) return { status: "RECHAZADO", contentId: asset.id, category: objective.category, reason: "El contenido dejó de ser borrador antes de la autorización técnica." };

    const scheduler = dependencies.scheduler || contentScheduler;
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('content-marketer-global'))");
        const active = await client.query("SELECT marketer_enabled,marketer_categories FROM director_config ORDER BY id DESC LIMIT 1");
        const latest = active.rows[0];
        if (latest?.marketer_enabled !== true || !latest.marketer_categories?.includes(objective.category)) {
            await client.query("ROLLBACK");
            return { status: "SIN_PUBLICACION", contentId: asset.id, category: objective.category, reason: "El marketero se pausó o la categoría se deshabilitó antes de programar." };
        }
        if (await hasPromoForDay(client, date)) {
            await client.query("ROLLBACK");
            return { status: "SIN_PUBLICACION", contentId: asset.id, category: objective.category, reason: "Ya se alcanzó el máximo de una publicación comercial para hoy." };
        }
        const result = await scheduler.schedulePublication({
            contentId: asset.id, idioma: "es", programadaPara: scheduledAt.toISOString(),
            idempotencyKey: `marketer-${date}`
        }, { pool: client, now });
        await client.query("COMMIT");
        await recordEvent(db, asset.id, "CONTENT_MARKETER_SCHEDULED", {
            scheduleId: result.schedule?.scheduleId || null, programadaPara: scheduledAt.toISOString(),
            destinationId: destination.destinationId, idempotencyKey: `marketer-${date}`
        });
        return { status: "PROGRAMADO", contentId: asset.id, category: objective.category,
            scheduledAt: scheduledAt.toISOString(), objective: objective.reason, scheduleId: result.schedule?.scheduleId || null };
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        return { status: "RECHAZADO", contentId: asset.id, category: objective.category,
            reason: `No se pudo programar: ${String(error.message || error).slice(0, 200)}` };
    } finally { client.release(); }
}

async function validateBeforePublish(contentId, db = pool, now = new Date(), dependencies = {}) {
    const asset = await (dependencies.library || contentLibrary).getContentAsset(contentId, db);
    if (!asset || asset.grupo !== GROUP) return { ok: true };
    const config = await (dependencies.config || directorConfig).getActiveConfig(db);
    if (!config.marketer?.enabled || !config.marketer.categories.includes(asset.categoria)) {
        return { ok: false, code: "MARKETER_PAUSED_OR_CATEGORY_DISABLED", error: "El marketero está pausado o la categoría ya no está autorizada." };
    }
    const metadata = asset.fuentes?.find(source => source.datosVerificados)?.datosVerificados;
    if (!metadata || metadata.policyVersion !== POLICY_VERSION || metadata.category !== asset.categoria) {
        return { ok: false, code: "MARKETER_POLICY_METADATA_MISSING", error: "La publicación no conserva la evidencia de validación requerida." };
    }
    const validationEvent = await db.query(`SELECT datos FROM content_events
        WHERE entity_type='CONTENT_ITEM' AND entity_id=$1 AND event_type='CONTENT_MARKETER_VALIDATED'
        ORDER BY ocurrido_at DESC LIMIT 1`, [contentId]);
    const validation = validationEvent.rows[0]?.datos || null;
    const bodyHash = createHash("sha256").update(asset.cuerpo).digest("hex");
    if (asset.estado !== "ACTIVO" || !validation || Number(asset.revisionId) !== Number(validation.revisionId)
        || validation.bodyHash !== bodyHash) {
        return { ok: false, code: "MARKETER_CONTENT_CHANGED", error: "El contenido cambió después de validarse o ya no está activo." };
    }
    if (!await getDestination(dependencies, db)) {
        return { ok: false, code: "MARKETER_DESTINATION_UNAVAILABLE", error: "El grupo oficial validado ya no está disponible." };
    }
    if (asset.categoria === "referidos") {
        const acquisition = dependencies.acquisition || customerAcquisition;
        const [current, summary] = await Promise.all([acquisition.getProgramConfig(db), acquisition.getReferralSummary(db)]);
        const budget = referralBudget(current, summary);
        const old = metadata.referral;
        if (!isActiveReferralConfig(current, now) || budget.available < Number(current.max_reward_brl || 0) || !old
            || Number(current.reward_pct) !== old.rewardPct || Number(current.max_reward_brl) !== old.maxRewardBRL
            || new Date(current.expires_at).getTime() !== new Date(old.expiresAt).getTime()) {
            return { ok: false, code: "REFERRAL_TERMS_CHANGED", error: "Las condiciones o el presupuesto de referidos cambiaron desde la preparación." };
        }
    }
    if (asset.categoria === "opciones-recepcion") {
        const current = await loadCategoryFacts(asset.categoria, db, now, dependencies);
        const oldModes = metadata.offeringSnapshot || [];
        if (!current.available || oldModes.some(mode => !current.offeringSnapshot.includes(mode))) {
            return { ok: false, code: "RECEIVING_OPTIONS_CHANGED", error: "Una modalidad mencionada dejó de estar disponible desde la preparación." };
        }
    }
    return { ok: true };
}

async function getSnapshot(db = pool) {
    const cfg = await directorConfig.getActiveConfig(db);
    const [metrics, categories, upcoming, latest, activity, rejected, runs] = await Promise.all([
        db.query(`SELECT
            (SELECT COUNT(*)::int FROM content_items WHERE grupo=$1 AND origen_sistema LIKE 'marketer-%' AND creado_at>=NOW()-INTERVAL '7 days') AS generated,
            (SELECT COUNT(DISTINCT ev.entity_id)::int FROM content_events ev JOIN content_items ci ON ci.id=ev.entity_id WHERE ev.entity_type='CONTENT_ITEM' AND ev.event_type='CONTENT_MARKETER_VALIDATED' AND ci.origen_sistema LIKE 'marketer-%' AND ev.ocurrido_at>=NOW()-INTERVAL '7 days') AS validated,
            (SELECT COUNT(DISTINCT ev.entity_id)::int FROM content_events ev JOIN content_items ci ON ci.id=ev.entity_id WHERE ev.entity_type='CONTENT_ITEM' AND ev.event_type='CONTENT_MARKETER_REJECTED' AND ci.origen_sistema LIKE 'marketer-%' AND ev.ocurrido_at>=NOW()-INTERVAL '7 days') AS rejected,
            (SELECT COUNT(*)::int FROM content_schedules cs JOIN content_items ci ON ci.id=cs.content_item_id WHERE ci.grupo=$1 AND cs.idempotency_key LIKE 'marketer-%' AND cs.estado='PENDIENTE') AS scheduled,
            (SELECT COUNT(*)::int FROM content_publications cp JOIN content_items ci ON ci.id=cp.content_item_id WHERE ci.grupo=$1 AND ci.origen_sistema LIKE 'marketer-%' AND cp.estado='PUBLICADA' AND cp.publicada_at>=NOW()-INTERVAL '7 days') AS providerAccepted,
            ((SELECT COUNT(*) FROM content_schedules cs JOIN content_items ci ON ci.id=cs.content_item_id WHERE ci.grupo=$1 AND cs.idempotency_key LIKE 'marketer-%' AND cs.estado IN ('FALLIDA','AMBIGUA') AND cs.ejecutada_at>=NOW()-INTERVAL '7 days')+
             (SELECT COUNT(*) FROM content_publications cp JOIN content_items ci ON ci.id=cp.content_item_id WHERE ci.grupo=$1 AND ci.origen_sistema LIKE 'marketer-%' AND cp.estado IN ('FALLIDA','AMBIGUA') AND cp.iniciada_at>=NOW()-INTERVAL '7 days'))::int AS failed
        `, [GROUP]),
        db.query(`SELECT ci.categoria,COUNT(*)::int AS total FROM content_items ci
            WHERE ci.grupo=$1 AND ci.origen_sistema LIKE 'marketer-%' AND ci.creado_at>=NOW()-INTERVAL '7 days' GROUP BY ci.categoria ORDER BY total DESC`, [GROUP]),
        db.query(`SELECT ci.id,ci.titulo,ci.categoria,cs.programada_para,cs.estado FROM content_schedules cs
            JOIN content_items ci ON ci.id=cs.content_item_id WHERE ci.grupo=$1 AND cs.idempotency_key LIKE 'marketer-%' AND cs.estado='PENDIENTE'
            ORDER BY cs.programada_para LIMIT 5`, [GROUP]),
        db.query(`SELECT ci.id,ci.titulo,ci.categoria,cp.estado,cp.publicada_at,cp.error
            FROM content_publications cp JOIN content_items ci ON ci.id=cp.content_item_id
            WHERE ci.grupo=$1 AND ci.origen_sistema LIKE 'marketer-%' ORDER BY COALESCE(cp.publicada_at,cp.iniciada_at,cp.creado_at) DESC LIMIT 10`, [GROUP]),
        db.query(`SELECT cp.id,ci.titulo,cp.publicada_at,
            (SELECT COUNT(*)::int FROM commercial_funnel_quotes q WHERE q.created_at>=cp.publicada_at AND q.created_at<cp.publicada_at+INTERVAL '24 hours') AS quotes_24h,
            (SELECT COUNT(*)::int FROM operations o WHERE o.completed_at>=cp.publicada_at AND o.completed_at<cp.publicada_at+INTERVAL '24 hours' AND o.status='completada') AS remittances_24h
            FROM content_publications cp JOIN content_items ci ON ci.id=cp.content_item_id
            WHERE ci.grupo=$1 AND ci.origen_sistema LIKE 'marketer-%' AND cp.estado='PUBLICADA' AND cp.publicada_at>=NOW()-INTERVAL '30 days'
            ORDER BY cp.publicada_at DESC LIMIT 10`, [GROUP]),
        db.query(`SELECT ci.id,ci.titulo,ci.categoria,ev.datos->>'reason' AS reason,ev.ocurrido_at
            FROM content_events ev JOIN content_items ci ON ci.id=ev.entity_id
            WHERE ev.entity_type='CONTENT_ITEM' AND ev.event_type='CONTENT_MARKETER_REJECTED' AND ci.origen_sistema LIKE 'marketer-%'
            ORDER BY ev.ocurrido_at DESC LIMIT 10`),
        db.query(`SELECT id,fecha,estado,iniciado_at,detalle->'marketing' AS marketing
            FROM director_runs WHERE detalle ? 'marketing' ORDER BY id DESC LIMIT 10`)
    ]);
    return {
        settings: cfg.marketer || directorConfig.DEFAULT_MARKETER,
        timezone: TIME_ZONE,
        maxPerDay: MAX_PROMOTIONS_PER_DAY,
        metrics: metrics.rows[0] || { generated: 0, validated: 0, rejected: 0, scheduled: 0, providerAccepted: 0, failed: 0 },
        categories: categories.rows,
        upcoming: upcoming.rows,
        recent: latest.rows,
        rejected: rejected.rows,
        runs: runs.rows,
        activityAfterPublication: activity.rows.map(row => ({ ...row, note: "Actividad observada en las 24 h posteriores; no prueba atribución causal." }))
    };
}

async function setSettings(input, actor = "admin", db = pool, dependencies = {}) {
    const current = await directorConfig.getActiveConfig(db);
    const marketer = {
        enabled: input?.enabled === true,
        categories: input?.categories ?? current.marketer.categories,
        time: input?.time ?? current.marketer.time
    };
    if (marketer.enabled) {
        const destination = await getDestination(dependencies, db);
        if (!destination) throw marketerError("No se puede activar: registra y valida el grupo oficial de WhatsApp primero.", 409);
        if (!(env.ZAPI_INSTANCE && env.ZAPI_TOKEN && env.ZAPI_CLIENT_TOKEN)) throw marketerError("No se puede activar: faltan credenciales del publicador Z-API.", 409);
    }
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('content-marketer-global'))");
        const saved = await directorConfig.saveConfig({
            mezcla: current.mezcla, umbralImpacto: current.umbralImpacto, maxBorradores: current.maxBorradores,
            ventanaDias: current.ventanaDias, ajusteMaximo: current.ajusteMaximo,
            penalizacionRepeticion: current.penalizacionRepeticion,
            diasAlertaSinBorradores: current.diasAlertaSinBorradores,
            marketer, motivo: `Configuración del marketero automático desde el Centro de Operaciones por ${String(actor).slice(0, 80)}.`
        }, client);
        if (!saved.marketer.enabled) await cancelPendingPromotions(client, "Marketero pausado desde la configuración administrativa.", true);
        await client.query("COMMIT");
        return saved.marketer;
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally { client.release(); }
}

async function cancelPendingPromotions(db = pool, reason = "El marketero está pausado.", insideTransaction = false) {
    const client = insideTransaction ? db : await db.connect();
    try {
        if (!insideTransaction) {
            await client.query("BEGIN");
            await client.query("SELECT pg_advisory_xact_lock(hashtext('content-marketer-global'))");
        }
        const result = await client.query(`WITH canceled AS (
            UPDATE content_schedules cs SET estado='CANCELADA',cancelada_at=NOW(),actualizado_at=NOW(),
                error=$1,result_code='MARKETER_PAUSED'
            FROM content_items ci WHERE ci.id=cs.content_item_id AND ci.grupo=$2
                AND cs.idempotency_key LIKE 'marketer-%' AND cs.estado='PENDIENTE'
            RETURNING cs.id
        ), events AS (
            INSERT INTO content_events (entity_type,entity_id,event_type,actor,datos)
            SELECT 'SCHEDULE',id,'CONTENT_MARKETER_SCHEDULE_CANCELED','system',jsonb_build_object('reason',$1) FROM canceled
        ) SELECT id FROM canceled`, [String(reason).slice(0, 300), GROUP]);
        if (!insideTransaction) await client.query("COMMIT");
        return result.rows.length;
    } catch (error) {
        if (!insideTransaction) try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally { if (!insideTransaction) client.release(); }
}

module.exports = {
    TIME_ZONE, GROUP, MAX_PROMOTIONS_PER_DAY, POLICY_VERSION, CATEGORY_NAMES, FACTS,
    assertSafeHook, marketerSchema, buildCategoryContent, loadCategoryFacts, selectObjective,
    hasPromoForDay, runDaily, validateBeforePublish, getSnapshot, setSettings, cancelPendingPromotions,
    isActiveReferralConfig, referralBudget, similarityTokens, tokenSimilarity, stableJson, findRecentSimilarContent
};
