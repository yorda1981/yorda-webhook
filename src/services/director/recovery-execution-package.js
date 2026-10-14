"use strict";

const pool = require("../../../db");
const recuperacion = require("../recuperacion");
const mensajes = require("../recuperacion-mensajes");
const recuperacionEnvios = require("../recuperacion-envios");
const contentLibrary = require("../content-library");
const promotionCalculator = require("./promotion-calculator");

const PACKAGE_TYPE = "RECUPERACION_ABANDONOS";
const STATES = new Set(["BORRADOR", "APROBADO", "CANCELADO"]);

function validationError(message) {
    const error = new Error(message);
    error.code = "CONTENT_DIRECTOR_VALIDATION";
    return error;
}

function isRecoveryDecision(decision) {
    if (!decision || decision.estado !== "VIGENTE") return false;
    const citesAbandonment = (decision.evidencia || []).some(fact => fact?.id === "F4");
    const text = `${decision.decision || ""} ${decision.problema || ""} ${decision.accionRecomendada || ""}`.toLowerCase();
    return citesAbandonment && /abandon|recuper|reactiv/.test(text);
}

function seededRng(value) {
    let seed = [...String(value || "")].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 2166136261);
    return () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 4294967296;
    };
}

function segmentName(candidate) {
    if (candidate.prioridad === "alta") return "Llegó al PIX";
    if (candidate.antiguedad === "recuperacion") return "Cotizó hace más de 7 días";
    return "Cotizó sin completar";
}

function countsBy(items, selector) {
    const counts = {};
    for (const item of items) {
        const key = selector(item) || "Sin definir";
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

function campaignDraft(total, high, medium) {
    return `Revisar ${total} cliente${total === 1 ? "" : "s"} elegible${total === 1 ? "" : "s"}. Empezar por ${high} que llegaron al PIX y continuar con ${medium} que cotizaron sin completar. Cada cliente ya tiene un mensaje individual preparado.`;
}

function buildPackageContent(decision, candidates, now = new Date()) {
    const clients = candidates.map(candidate => {
        const preview = mensajes.generarMensajePreview(candidate, { rng: seededRng(`${decision.id}:${candidate.phone}`) });
        return {
            phone: candidate.phone,
            incluido: true,
            nombre: candidate.nombre || null,
            segmento: segmentName(candidate),
            prioridad: candidate.prioridad,
            servicio: candidate.servicio,
            tipoFavorito: candidate.tipoFavorito || null,
            ultimoMonto: candidate.ultimoMonto,
            fechaIntento: candidate.fechaIntento,
            antiguedad: candidate.antiguedad,
            mensaje: preview.mensaje,
            familia: preview.familia,
            varianteIndice: preview.indice,
            tono: preview.antiguedadTono
        };
    });
    const high = clients.filter(client => client.prioridad === "alta").length;
    const medium = clients.length - high;
    return {
        objetivo: "Recuperar clientes con intención comercial comprobada que no llegaron a crear una operación.",
        generadoAt: now.toISOString(),
        segmento: {
            total: clients.length,
            altaPrioridad: high,
            prioridadMedia: medium,
            porSegmento: countsBy(clients, client => client.segmento),
            porServicio: countsBy(clients, client => client.servicio)
        },
        criterios: [
            "El cliente llegó a cotización o quedó esperando comprobante hace más de 2 horas.",
            "No está bloqueado ni bajo pausa humana.",
            "No tiene una operación pendiente, confirmada o completada posterior al intento.",
            "No recibió una recuperación exitosa durante las últimas 24 horas."
        ],
        clientes: clients,
        mensajes: {
            totalPreparados: clients.length,
            origen: "Motor de mensajes de recuperación existente",
            personalizados: true
        },
        secuencia: [
            { orden: 1, segmento: "Llegó al PIX", accion: "Revisar y enviar primero", momento: "Próxima ventana recomendada" },
            { orden: 2, segmento: "Cotizó sin completar", accion: "Revisar y enviar después del segmento de alta prioridad", momento: "Segunda ventana recomendada" },
            { orden: 3, segmento: "Todos", accion: "No repetir automáticamente; respetar el cooldown existente de 24 horas", momento: "Después del envío" }
        ],
        horario: {
            zona: "America/Sao_Paulo",
            primeraVentana: "09:00–11:00",
            segundaVentana: "15:00–17:00",
            criterio: "Evitar horas tempranas, nocturnas y concentrar primero los casos más cercanos al pago."
        },
        duracion: "1 día de ejecución y 48 horas de observación.",
        campana: {
            nombre: "Recuperación de intentos abandonados",
            borrador: campaignDraft(clients.length, high, medium)
        },
        publicaciones: {
            necesarias: false,
            borradores: [],
            motivo: "La oportunidad afecta a clientes identificados individualmente; una publicación al grupo añadiría ruido y no mejora la recuperación directa."
        },
        metricas: [
            { nombre: "Clientes elegibles", base: clients.length, medicion: "Tamaño del paquete al generarse" },
            { nombre: "Mensajes aprobados", base: 0, medicion: "Clientes incluidos al aprobar el paquete" },
            { nombre: "Mensajes enviados", base: 0, medicion: "Envíos registrados en recuperacion_envios" },
            { nombre: "Operaciones recuperadas", base: 0, medicion: "Operaciones creadas después del contacto" },
            { nombre: "Remesas recuperadas", base: 0, medicion: "Operaciones completadas después del contacto" }
        ],
        resultadoEsperado: decision.resultadoEsperado,
        estrategia: "Priorizar intención reciente y cercanía al pago, reutilizando filtros y mensajes ya validados por YORDA."
    };
}

function mapPackage(row) {
    if (!row) return null;
    return {
        id: Number(row.id), decisionId: Number(row.decision_id), tipo: row.tipo,
        estado: row.estado, contenido: row.contenido,
        creadoAt: row.creado_at, actualizadoAt: row.actualizado_at, resueltoAt: row.resuelto_at
    };
}

function refreshOfferSimulation(strategy, promotionContext) {
    if (!strategy) return strategy;
    const offer = strategy.oferta || null;
    const simulation = offer ? promotionCalculator.findOfferScenario(promotionContext, offer) : [];
    if (!offer) return { ...strategy, simulacionPromocion: [] };
    const costSummary = simulation.length ? simulation.map(item => ({ transferenciaBRL: item.importeTransferenciaBRL,
        costoBeneficioBRL: item.costoBeneficioBRL, margenReferenciaRestanteBRL: item.margenReferenciaRestanteBRL,
        margenReferenciaRestantePct: item.margenReferenciaRestantePct })) : null;
    return { ...strategy, simulacionPromocion: simulation,
        ejecutable: false,
        costo: { tipo: "ECONOMICO", estimacion: costSummary, baseVerificada: false,
            explicacion: simulation.length
                ? "Beneficio valorizado con tasa vigente; no equivale al costo real de liquidación. El margen restante es una referencia del 5 %, no rentabilidad neta verificada."
                : `Cálculo pendiente: ${promotionContext?.motivo || "no existe una tasa vigente válida"}` } };
}

function refreshCommercialAlternatives(alternatives, promotionContext) {
    return (Array.isArray(alternatives) ? alternatives : []).map(item => refreshOfferSimulation(item, promotionContext));
}

function buildInitiativeContent(decision, now = new Date(), promotionContext = null) {
    const alternatives = Array.isArray(decision.alternativas) ? decision.alternativas : [];
    const recalculatedAlternatives = alternatives.map(item => refreshOfferSimulation(item, promotionContext));
    const selectedId = decision.estrategiaElegida?.id;
    const winner = refreshOfferSimulation(decision.estrategiaElegida
        || recalculatedAlternatives.find(item => item.id === selectedId)
        || recalculatedAlternatives[0] || null, promotionContext);
    const materials = winner?.materiales || [];
    const libraryMaterials = materials.filter(item => item.tipo === "biblioteca" && item.titulo && item.contenido);
    const recovery = isRecoveryDecision(decision);
    const missing = [...(winner?.capacidadesFaltantes || [])];
    if (winner?.oferta && !winner.simulacionPromocion?.length) missing.push("La propuesta económica no se puede calcular: falta una tasa diaria vigente válida.");
    if (winner?.oferta) missing.push("No hay costos reales de liquidación ni margen neto verificados; la oferta no puede aprobarse ni activarse.");
    for (const material of materials.filter(item => item.tipo !== "biblioteca")) {
        missing.push(`No hay un adaptador operativo para ejecutar material tipo ${material.tipo || "sin tipo"}; requiere acción manual revisada.`);
    }
    if (!recovery && !libraryMaterials.length) {
        missing.push("No existe todavía un adaptador operativo para ejecutar esta estrategia desde YORDA.");
    }
    return {
        objetivo: decision.problema,
        generadoAt: now.toISOString(),
        estrategiaElegida: winner,
        alternativas: recalculatedAlternatives,
        simulacionPromocion: promotionContext || { disponible: false, motivo: "No calculada", escenarios: [] },
        destinatarios: winner?.destinatarios || { criterio: "Sin segmentación individual verificable", basadoEnDatos: false },
        materiales: materials,
        costos: winner?.costo || { tipo: "DESCONOCIDO", estimacion: null, baseVerificada: false,
            explicacion: "No hay costos unitarios ni ganancia neta registrados para validar importes." },
        plan: winner?.pasos || [decision.accionRecomendada],
        metricas: winner?.metricas || ["Remesas completadas", "Ganancia neta (no disponible hasta registrar costos reales)"],
        resultadoEsperado: winner?.resultadoEsperado || decision.resultadoEsperado,
        capacidadesFaltantes: [...new Set(missing)],
        ejecucion: {
            adaptador: recovery ? "RECUPERACION_CRM" : libraryMaterials.length ? "BIBLIOTECA_BORRADOR" : null,
            listaParaAprobar: recovery || (libraryMaterials.length > 0 && !winner?.requiereCompromisoEconomico && !winner?.oferta),
            requiereAprobacion: true,
            publicacionesAutomaticas: false,
            mensajesAutomaticos: false,
            activosBiblioteca: []
        },
        recuperacion: recovery ? buildPackageContent(decision, [], now) : null
    };
}

async function ensureCommercialPackage(decision, db = pool, dependencies = {}) {
    const existing = await getPackageForDecision(decision.id, db);
    if (existing) {
        const content = existing.contenido || {};
        if (existing.tipo === "INICIATIVA_COMERCIAL" && existing.estado === "BORRADOR") {
            const promotionContext = await promotionCalculator.getCurrentPromotionScenarios(db, dependencies.now || new Date());
            const refreshed = buildInitiativeContent(decision, dependencies.now || new Date(), promotionContext);
            const withAlternatives = { ...content, ...refreshed,
                objetivo: content.objetivo || refreshed.objetivo,
                generadoAt: content.generadoAt || refreshed.generadoAt,
                materiales: content.materiales || refreshed.materiales,
                plan: content.plan || refreshed.plan };
            if (JSON.stringify(content) === JSON.stringify(withAlternatives)) return existing;
            const updated = await db.query("UPDATE director_execution_packages SET contenido = $2::jsonb, actualizado_at = NOW() WHERE id = $1 RETURNING *",
                [existing.id, JSON.stringify(withAlternatives)]);
            return mapPackage(updated.rows[0]);
        }
        const promotionContext = existing.estado === "BORRADOR"
            ? await promotionCalculator.getCurrentPromotionScenarios(db, dependencies.now || new Date())
            : content.simulacionPromocion;
        const withAlternatives = { ...content,
            alternativas: refreshCommercialAlternatives(decision.alternativas || content.alternativas || [], promotionContext),
            estrategiaElegida: refreshOfferSimulation(decision.estrategiaElegida || content.estrategiaElegida || null, promotionContext),
            simulacionPromocion: promotionContext || { disponible: false, motivo: "No recalculada", escenarios: [] } };
        if (existing.estado === "BORRADOR" && withAlternatives.alternativas.length
            && (JSON.stringify(content.alternativas || []) !== JSON.stringify(withAlternatives.alternativas)
                || JSON.stringify(content.estrategiaElegida || null) !== JSON.stringify(withAlternatives.estrategiaElegida)
                || JSON.stringify(content.simulacionPromocion || null) !== JSON.stringify(withAlternatives.simulacionPromocion))) {
            const updated = await db.query("UPDATE director_execution_packages SET contenido = $2::jsonb, actualizado_at = NOW() WHERE id = $1 RETURNING *",
                [existing.id, JSON.stringify(withAlternatives)]);
            return mapPackage(updated.rows[0]);
        }
        return existing;
    }
    if (isRecoveryDecision(decision)) {
        const candidates = await (dependencies.getCandidates || recuperacion.obtenerCandidatosRecuperacion)(db, { throwOnError: true });
        const promotionContext = await promotionCalculator.getCurrentPromotionScenarios(db, dependencies.now || new Date());
        const content = { ...buildPackageContent(decision, candidates, dependencies.now || new Date()),
            alternativas: refreshCommercialAlternatives(decision.alternativas, promotionContext),
            estrategiaElegida: refreshOfferSimulation(decision.estrategiaElegida, promotionContext),
            simulacionPromocion: promotionContext,
            ejecucion: { adaptador: "RECUPERACION_CRM", listaParaAprobar: true, requiereAprobacion: true,
                publicacionesAutomaticas: false, mensajesAutomaticos: false, resultados: [] } };
        const result = await db.query(`
            INSERT INTO director_execution_packages (decision_id, tipo, estado, contenido)
            VALUES ($1, $2, 'BORRADOR', $3::jsonb) ON CONFLICT (decision_id) DO NOTHING RETURNING *
        `, [decision.id, PACKAGE_TYPE, JSON.stringify(content)]);
        return result.rows[0] ? mapPackage(result.rows[0]) : getPackageForDecision(decision.id, db);
    }
    const promotionContext = await promotionCalculator.getCurrentPromotionScenarios(db, dependencies.now || new Date());
    const content = buildInitiativeContent(decision, dependencies.now || new Date(), promotionContext);
    const result = await db.query(`
        INSERT INTO director_execution_packages (decision_id, tipo, estado, contenido)
        VALUES ($1, 'INICIATIVA_COMERCIAL', 'BORRADOR', $2::jsonb)
        ON CONFLICT (decision_id) DO NOTHING RETURNING *
    `, [decision.id, JSON.stringify(content)]);
    return result.rows[0] ? mapPackage(result.rows[0]) : getPackageForDecision(decision.id, db);
}

async function getPackageForDecision(decisionId, db = pool) {
    const id = Number(decisionId);
    if (!Number.isSafeInteger(id) || id <= 0) throw validationError("Decisión inválida.");
    const result = await db.query("SELECT * FROM director_execution_packages WHERE decision_id = $1", [id]);
    return mapPackage(result.rows[0]);
}

async function ensureRecoveryPackage(decision, db = pool, dependencies = {}) {
    if (!isRecoveryDecision(decision)) return null;
    const existing = await getPackageForDecision(decision.id, db);
    if (existing) return ensureCommercialPackage(decision, db, dependencies);
    const getCandidates = dependencies.getCandidates || recuperacion.obtenerCandidatosRecuperacion;
    const candidates = await getCandidates(db, { throwOnError: true });
    const promotionContext = await promotionCalculator.getCurrentPromotionScenarios(db, dependencies.now || new Date());
    const content = { ...buildPackageContent(decision, candidates, dependencies.now || new Date()),
        alternativas: refreshCommercialAlternatives(decision.alternativas, promotionContext),
        estrategiaElegida: refreshOfferSimulation(decision.estrategiaElegida, promotionContext),
        simulacionPromocion: promotionContext };
    const result = await db.query(`
        INSERT INTO director_execution_packages (decision_id, tipo, estado, contenido)
        VALUES ($1, $2, 'BORRADOR', $3::jsonb)
        ON CONFLICT (decision_id) DO UPDATE SET decision_id = EXCLUDED.decision_id
        RETURNING *
    `, [decision.id, PACKAGE_TYPE, JSON.stringify(content)]);
    return mapPackage(result.rows[0]);
}

function normalizeEditableContent(input, current) {
    const content = structuredClone(current);
    if (Array.isArray(content.alternativas)) {
        if (input.objetivo !== undefined) content.objetivo = String(input.objetivo).trim().slice(0, 2000);
        if (Array.isArray(input.materiales)) {
            const winner = content.estrategiaElegida;
            const changes = new Map(input.materiales.map((item, index) => [Number(item?.indice ?? index), item]));
            winner.materiales = (winner.materiales || []).map((material, index) => {
                const change = changes.get(index);
                if (!change) return material;
                const titulo = String(change.titulo ?? material.titulo).trim().slice(0, 180);
                const contenido = String(change.contenido ?? material.contenido).trim().slice(0, 4000);
                if (!titulo || !contenido) throw validationError("El material de la iniciativa no puede quedar vacío.");
                return { ...material, titulo, contenido };
            });
            content.materiales = winner.materiales;
        }
        if (!content.objetivo) throw validationError("El objetivo comercial es obligatorio.");
        return content;
    }
    const campaignDraftWasGenerated = input.campana?.borrador === current.campana.borrador;
    for (const field of ["objetivo", "duracion", "resultadoEsperado", "estrategia"]) {
        if (input[field] !== undefined) content[field] = String(input[field]).trim().slice(0, 2000);
    }
    if (input.campana?.nombre !== undefined) content.campana.nombre = String(input.campana.nombre).trim().slice(0, 200);
    if (input.campana?.borrador !== undefined) content.campana.borrador = String(input.campana.borrador).trim().slice(0, 4000);
    if (input.horario?.primeraVentana !== undefined) content.horario.primeraVentana = String(input.horario.primeraVentana).trim().slice(0, 80);
    if (input.horario?.segundaVentana !== undefined) content.horario.segundaVentana = String(input.horario.segundaVentana).trim().slice(0, 80);
    if (Array.isArray(input.clientes)) {
        const changes = new Map(input.clientes.map(client => [String(client?.phone || ""), client]));
        content.clientes = content.clientes.map(client => {
            const change = changes.get(client.phone);
            if (!change) return client;
            const message = String(change.mensaje ?? client.mensaje).trim().slice(0, 2000);
            if (!message) throw validationError(`El mensaje de ${client.phone} no puede quedar vacío.`);
            return { ...client, incluido: change.incluido !== false, mensaje: message };
        });
        const included = content.clientes.filter(client => client.incluido !== false);
        content.mensajes.totalPreparados = included.length;
        content.segmento.total = included.length;
        content.segmento.altaPrioridad = included.filter(client => client.prioridad === "alta").length;
        content.segmento.prioridadMedia = included.length - content.segmento.altaPrioridad;
        content.segmento.porSegmento = countsBy(included, client => client.segmento);
        content.segmento.porServicio = countsBy(included, client => client.servicio);
        if (campaignDraftWasGenerated) {
            content.campana.borrador = campaignDraft(included.length, content.segmento.altaPrioridad, content.segmento.prioridadMedia);
        }
    }
    if (!content.objetivo || !content.campana.nombre || !content.campana.borrador) throw validationError("El objetivo y el borrador de campaña son obligatorios.");
    return content;
}

async function updatePackage(rawId, input, db = pool) {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) throw validationError("Paquete inválido.");
    const current = await db.query("SELECT * FROM director_execution_packages WHERE id = $1", [id]);
    const row = current.rows[0];
    if (!row) return null;
    if (row.estado !== "BORRADOR") throw validationError("Solo se puede modificar un paquete en borrador.");
    const content = normalizeEditableContent(input || {}, row.contenido);
    const previous = row.contenido || {};
    const changedFields = [];
    if (previous.objetivo !== content.objetivo) changedFields.push("objetivo");
    if (Array.isArray(content.alternativas)) {
        if (JSON.stringify(previous.materiales) !== JSON.stringify(content.materiales)) changedFields.push("materiales");
    } else {
        if (JSON.stringify(previous.clientes) !== JSON.stringify(content.clientes)) changedFields.push("destinatarios_o_mensajes");
        if (JSON.stringify(previous.campana) !== JSON.stringify(content.campana)) changedFields.push("campana");
        if (JSON.stringify(previous.horario) !== JSON.stringify(content.horario)) changedFields.push("secuencia_u_horario");
    }
    if (changedFields.length) content.señalesOperador = [...(previous.señalesOperador || []), {
        tipo: "EDITADO", campos: changedFields, ocurridoAt: new Date().toISOString()
    }].slice(-20);
    const result = await db.query(`UPDATE director_execution_packages SET contenido = $2::jsonb, actualizado_at = NOW()
                                   WHERE id = $1 AND estado = 'BORRADOR' RETURNING *`, [id, JSON.stringify(content)]);
    return mapPackage(result.rows[0]);
}

function hasRateSensitiveClaim(message) {
    return /\b(tasas?|cotizaciones?|cotizar|CUP|BRL|R\$|beneficios?|descuentos?|bonos?|promoci[oó]n(?:es)?|oferta(?:s)?)\b/i.test(String(message || ""));
}

function packageHasRateDependentContent(row, content) {
    if (row.tipo === "RECUPERACION_ABANDONOS") {
        return (content.clientes || []).some(client => client.incluido !== false && hasRateSensitiveClaim(client.mensaje));
    }
    if (content.estrategiaElegida?.oferta) return true;
    return (content.materiales || []).some(material => hasRateSensitiveClaim(`${material.titulo || ""} ${material.contenido || ""}`));
}

function refreshContentForRates(content, context, row, now, alreadySentPhones = []) {
    const alternatives = refreshCommercialAlternatives(content.alternativas, context);
    const winner = refreshOfferSimulation(content.estrategiaElegida, context);
    const refreshed = { ...content, alternativas: alternatives, estrategiaElegida: winner, simulacionPromocion: context };
    if (row.tipo === "INICIATIVA_COMERCIAL") {
        const rebuilt = buildInitiativeContent({ ...content, alternativas: alternatives, estrategiaElegida: winner }, now, context);
        Object.assign(refreshed, { costos: rebuilt.costos, capacidadesFaltantes: rebuilt.capacidadesFaltantes,
            ejecucion: { ...content.ejecucion, listaParaAprobar: rebuilt.ejecucion.listaParaAprobar } });
        refreshed.materiales = (content.materiales || []).map(material => hasRateSensitiveClaim(material.contenido)
            ? { ...material, contenido: "Consulta con el equipo de YORDA la cotización vigente para tu envío antes de continuar." }
            : material);
    } else if (row.tipo === "RECUPERACION_ABANDONOS") {
        const sentPhones = new Set(alreadySentPhones.filter(result => ["ENVIADO", "YA_ENVIADO"].includes(result.estado)).map(result => result.phone));
        refreshed.clientes = (content.clientes || []).map(client => client.incluido !== false && !sentPhones.has(client.phone)
            && hasRateSensitiveClaim(client.mensaje)
            ? { ...client, mensaje: `Hola${client.nombre ? ` ${client.nombre}` : ""}, si quieres retomar tu envío, te ayudamos a cotizarlo con los valores vigentes antes de continuar.` }
            : client);
    }
    return refreshed;
}

async function persistRateRefresh(id, row, content, context, db, now) {
    const updatedContent = refreshContentForRates(content, context, row, now);
    await db.query("UPDATE director_execution_packages SET contenido = $2::jsonb, actualizado_at = NOW() WHERE id = $1 AND estado = 'BORRADOR'",
        [id, JSON.stringify(updatedContent)]);
    return updatedContent;
}

async function resolvePackage(rawId, action, db = pool, dependencies = {}) {
    const id = Number(rawId);
    const target = action === "approve" ? "APROBADO" : action === "cancel" ? "CANCELADO" : null;
    if (!Number.isSafeInteger(id) || id <= 0 || !target || !STATES.has(target)) throw validationError("Acción de paquete inválida.");
    const current = await db.query("SELECT * FROM director_execution_packages WHERE id = $1 AND estado = 'BORRADOR'", [id]);
    const row = current.rows[0];
    if (!row) return null;
    let content = row.contenido || {};
    if (action === "approve" && packageHasRateDependentContent(row, content)) {
        const promotionContext = await promotionCalculator.getCurrentPromotionScenarios(db, dependencies.now || new Date());
        const previousRevision = content.simulacionPromocion?.revision || null;
        if (!promotionContext.disponible || previousRevision !== promotionContext.revision) {
            await persistRateRefresh(id, row, content, promotionContext, db, dependencies.now || new Date());
            throw validationError(promotionContext.disponible
                ? "La tasa vigente cambió desde la última revisión. Se recalculó el paquete; revisa los importes antes de aprobar."
                : "No se pudo confirmar una tasa vigente válida. El paquete quedó pendiente de recálculo antes de aprobar.");
        }
        content.simulacionPromocion = promotionContext;
        if (content.estrategiaElegida?.oferta || (content.estrategiaElegida?.requiereCompromisoEconomico && !content.costos?.baseVerificada)) {
            throw validationError("No se puede aprobar una promoción económica sin costos reales y margen neto verificados.");
        }
        if (row.tipo === "INICIATIVA_COMERCIAL" && !content.ejecucion?.listaParaAprobar) {
            throw validationError("Esta iniciativa no puede aprobarse todavía: faltan verificaciones de rentabilidad o capacidad operativa.");
        }
    }
    content.señalesOperador = [...(content.señalesOperador || []), {
        tipo: action === "approve" ? "APROBADO" : "CANCELADO", ocurridoAt: new Date().toISOString()
    }].slice(-20);
    if (action === "approve" && row.tipo === "RECUPERACION_ABANDONOS") {
        const results = [];
        for (const client of content.clientes || []) {
            if (client.incluido === false) continue;
            if (hasRateSensitiveClaim(client.mensaje)) {
                const latestRates = await promotionCalculator.getCurrentPromotionScenarios(db, dependencies.now || new Date());
                if (!latestRates.disponible || latestRates.revision !== content.simulacionPromocion?.revision) {
                    content = refreshContentForRates(content, latestRates, row, dependencies.now || new Date(), results);
                    content.ejecucion = { ...(content.ejecucion || {}), adaptador: "RECUPERACION_CRM", resultadosParciales: results,
                        completados: results.filter(result => result.estado === "ENVIADO" || result.estado === "YA_ENVIADO").length,
                        fallidos: results.filter(result => !["ENVIADO", "YA_ENVIADO"].includes(result.estado)).length };
                    await db.query("UPDATE director_execution_packages SET contenido = $2::jsonb, actualizado_at = NOW() WHERE id = $1 AND estado = 'BORRADOR'",
                        [id, JSON.stringify(content)]);
                    throw validationError("La tasa cambió durante el envío. Se detuvieron los mensajes pendientes y se recalculó el paquete; revisa y vuelve a aprobar.");
                }
            }
            const sendRecovery = dependencies.sendRecovery || recuperacionEnvios.enviarRecuperacionManual;
            const sent = await sendRecovery({
                phone: client.phone, familia: client.familia, indice: client.varianteIndice,
                textoAprobado: client.mensaje, idempotencyKey: `director-package-${id}-${client.phone}`
            }, { pool: db });
            results.push({ phone: client.phone, estado: sent.code, error: sent.error || null });
        }
        content.ejecucion = { ...(content.ejecucion || {}), adaptador: "RECUPERACION_CRM", resultados: results,
            completados: results.filter(result => result.estado === "ENVIADO" || result.estado === "YA_ENVIADO").length,
            fallidos: results.filter(result => !["ENVIADO", "YA_ENVIADO"].includes(result.estado)).length };
    } else if (action === "approve" && row.tipo === "INICIATIVA_COMERCIAL") {
        const materials = (content.materiales || []).filter(item => item.tipo === "biblioteca" && item.titulo && item.contenido);
        if (!materials.length) throw validationError("Esta iniciativa aún no tiene un adaptador listo para ejecutarse.");
        const facts = content.estrategiaElegida?.evidencia || [];
        if (!facts.length) throw validationError("No se puede aprobar material sin evidencia citada.");
        const assets = [];
        for (let index = 0; index < materials.length; index += 1) {
            const material = materials[index];
            const createDraft = dependencies.createDirectorDraft || contentLibrary.createDirectorDraft;
            assets.push(await createDraft({
                titulo: material.titulo, cuerpo: material.contenido, grupo: "permanente",
                categoria: "iniciativa-comercial",
                aporte: content.estrategiaElegida?.justificacion || content.objetivo,
                impacto: { puntuacion: content.estrategiaElegida?.puntuacionComercial || 0 },
                fuentes: facts.map(fact => ({ nombre: "Datos internos de YORDA", titulo: fact.dato, url: "" })),
                origenSistema: `director-pkg-${id}-${index + 1}`
            }, db));
        }
        content.ejecucion = { ...content.ejecucion, activosBiblioteca: assets.map(asset => ({ id: asset.id, titulo: asset.titulo })),
            borradoresCreados: assets.length };
    }
    const result = await db.query(`UPDATE director_execution_packages SET estado = $2, contenido = $3::jsonb,
                                   actualizado_at = NOW(), resuelto_at = NOW()
                                   WHERE id = $1 AND estado = 'BORRADOR' RETURNING *`, [id, target, JSON.stringify(content)]);
    return mapPackage(result.rows[0]);
}

module.exports = {
    PACKAGE_TYPE, isRecoveryDecision, seededRng, segmentName, campaignDraft, buildPackageContent,
    refreshOfferSimulation, refreshCommercialAlternatives, buildInitiativeContent, getPackageForDecision, ensureRecoveryPackage, ensureCommercialPackage,
    normalizeEditableContent, updatePackage, resolvePackage
};
