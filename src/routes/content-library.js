"use strict";

const express = require("express");
const contentLibrary = require("../services/content-library");
const contentSelector = require("../services/content-selector");
const contentPublisher = require("../services/content-publisher");
const contentScheduler = require("../services/content-scheduler");
const dailyRates = require("../services/content-daily-rates");
const contentDestinations = require("../services/content-destinations");
const contentDirector = require("../services/director/content-director");
const directorConfig = require("../services/director/director-config");
const bestDecision = require("../services/director/best-decision");
const recoveryExecutionPackage = require("../services/director/recovery-execution-package");
const directorAiUsage = require("../services/director/ai-usage");
const customerAcquisition = require("../services/customer-acquisition");
const { verificarToken } = require("../middleware/admin-auth");
const { adminReadLimiter, adminWriteLimiter } = require("../middleware/admin-rate-limiters");

function sendError(res, error) {
    if (error?.code === "CONTENT_LIBRARY_VALIDATION" || error?.code === "CONTENT_SELECTOR_VALIDATION" || error?.code === "CONTENT_PUBLISHER_VALIDATION" || error?.code === "CONTENT_SCHEDULER_VALIDATION" || error?.code === "CONTENT_DESTINATION_VALIDATION" || error?.code === "CONTENT_DIRECTOR_VALIDATION" || error?.code === "CONTENT_DAILY_RATES_VALIDATION") {
        return res.status(400).json({ error: error.message });
    }
    if (error?.code === "CONTENT_DESTINATION_PROVIDER") return res.status(502).json({ error: error.message });
    console.error("❌ Content Library:", error.message);
    return res.status(500).json({ error: "No se pudo completar la operación." });
}

function createContentLibraryRouter({ service = contentLibrary, selector = contentSelector, publisher = contentPublisher, scheduler = contentScheduler, destinations = contentDestinations, rates = dailyRates, director = contentDirector, config = directorConfig, decision = bestDecision, executionPackage = recoveryExecutionPackage, acquisition = customerAcquisition } = {}) {
    const router = express.Router();

    router.get("/", adminReadLimiter, verificarToken, async (req, res) => {
        try {
            const assets = await service.listContentAssets(req.query || {});
            res.json({ assets });
        } catch (error) {
            sendError(res, error);
        }
    });

    // Read-only aunque use POST: el cuerpo puede ser largo y no se persiste.
    router.post("/preview", adminReadLimiter, verificarToken, async (req, res) => {
        try {
            const preview = service.previewContentAsset(req.body || {});
            res.json({ preview });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get("/selection", adminReadLimiter, verificarToken, async (req, res) => {
        try {
            const selected = await selector.selectContent({ idioma: req.query.idioma });
            if (!selected) return res.status(404).json({ error: "No hay contenido elegible para esos criterios." });
            res.json({ selected });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/publish", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const result = await publisher.publishSelectedContent(req.body || {});
            const status = result.code === "NO_ELIGIBLE_CONTENT" ? 404
                : result.code === "DESTINATION_NOT_FOUND" ? 404
                : result.code === "SEND_FAILED" || result.code === "AMBIGUOUS_RESULT" ? 502
                : 200;
            res.status(status).json(result);
        } catch (error) {
            sendError(res, error);
        }
    });

    // Referidos y segunda remesa: análisis y control administrativo; no hay
    // endpoints que envíen campañas o liquiden pagos automáticamente.
    router.get("/acquisition", adminReadLimiter, verificarToken, async (_req, res) => {
        try {
            const [overview, referrals, secondTransferCandidates] = await Promise.all([
                acquisition.getAcquisitionOverview(), acquisition.listReferrals({ limit: 100 }),
                acquisition.getSecondTransferCandidates({ limit: 100 })
            ]);
            res.json({ overview, referrals, secondTransferCandidates });
        } catch (error) { sendError(res, error); }
    });

    router.get("/acquisition/referrals", adminReadLimiter, verificarToken, async (req, res) => {
        try { res.json({ referrals: await acquisition.listReferrals({ status: req.query.status || null, limit: req.query.limit }) }); }
        catch (error) { sendError(res, error); }
    });

    router.post("/acquisition/referrals/manual", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const result = await acquisition.recordReferralLink({
                referredPhone: req.body?.referredPhone, code: req.body?.code,
                evidence: "ADMIN_VERIFIED", evidenceNote: req.body?.evidenceNote, actor: "admin"
            });
            if (!result.linked) return res.status(409).json({ error: result.reason });
            res.status(201).json({ referral: result });
        } catch (error) { sendError(res, error); }
    });

    router.get("/acquisition/second-transfer-candidates", adminReadLimiter, verificarToken, async (req, res) => {
        try { res.json({ candidates: await acquisition.getSecondTransferCandidates({ limit: req.query.limit }) }); }
        catch (error) { sendError(res, error); }
    });

    router.post("/acquisition/customers/:phone/code", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const program = await acquisition.getProgramConfig();
            if (!program.enabled) return res.status(409).json({ error: "El programa de referidos está desactivado; no se generan códigos para compartir." });
            const code = await acquisition.ensureReferralCode(req.params.phone);
            if (!code) return res.status(404).json({ error: "Cliente no encontrado" });
            res.json({ code });
        } catch (error) { sendError(res, error); }
    });

    router.post("/acquisition/config", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const saved = await acquisition.saveProgramConfig(req.body || {}, "admin");
            res.json({ config: saved });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
            sendError(res, error);
        }
    });

    router.post("/acquisition/referrals/:id/:action", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const referral = await acquisition.transitionReferral(req.params.id, req.params.action, {
                actor: "admin", method: req.body?.method, reference: req.body?.reference
            });
            res.json({ referral });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            sendError(res, error);
        }
    });

    // Director IA: últimas ejecuciones y ejecución a demanda (solo crea borradores).
    router.get("/director/status", adminReadLimiter, verificarToken, async (_req, res) => {
        try {
            const [status, aiUsage] = await Promise.all([director.getDirectorStatus(), directorAiUsage.getDailySummary()]);
            res.json({ ...status, aiUsage });
        } catch (error) {
            sendError(res, error);
        }
    });

    // Configuración comercial versionada: cada cambio guarda su motivo.
    router.get("/director/config", adminReadLimiter, verificarToken, async (_req, res) => {
        try {
            res.json({ config: await config.getActiveConfig(), history: await config.getConfigHistory(), familias: config.FAMILIES });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/director/config", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            res.status(201).json({ config: await config.saveConfig(req.body || {}) });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/director/run", adminWriteLimiter, verificarToken, async (_req, res) => {
        try {
            const result = await director.requestManualRun();
            if (!result.started) {
                const message = result.reason === "DISABLED" ? "El Director IA está desactivado." : "El Director IA ya está trabajando.";
                return res.status(409).json({ error: message, reason: result.reason });
            }
            res.status(202).json(result);
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get("/director/decision", adminReadLimiter, verificarToken, async (_req, res) => {
        try {
            res.json({ decision: await decision.getBestDecision() });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/director/decision/refresh", adminWriteLimiter, verificarToken, async (_req, res) => {
        try {
            // La petición del operador debe devolver cualquier fallo real. El
            // job horario usa el lock entre instancias y puede saltarse en
            // silencio; una acción manual no debe aparentar que reevaluó.
            res.json(await decision.evaluateBestDecision());
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/director/decision/:id/:action", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const closed = await decision.closeDecision(req.params.id, req.params.action);
            if (!closed) return res.status(404).json({ error: "La decisión ya no está vigente." });
            res.json({ decision: closed });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get("/director/decision/:id/package", adminReadLimiter, verificarToken, async (req, res) => {
        try {
            const current = await decision.getBestDecision();
            if (!current || current.id !== Number(req.params.id)) return res.status(404).json({ error: "La decisión ya no está vigente." });
            const packageReady = await executionPackage.ensureCommercialPackage(current);
            res.json({ package: packageReady });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/director/execution-package/:id", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const packageReady = await executionPackage.updatePackage(req.params.id, req.body || {});
            if (!packageReady) return res.status(404).json({ error: "Paquete no encontrado." });
            res.json({ package: packageReady });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/director/execution-package/:id/:action", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const packageReady = await executionPackage.resolvePackage(req.params.id, req.params.action);
            if (!packageReady) return res.status(409).json({ error: "El paquete ya fue resuelto." });
            res.json({ package: packageReady });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get("/destinations", adminReadLimiter, verificarToken, async (_req, res) => {
        try {
            res.json({ destinations: await destinations.listDestinations() });
        } catch (error) {
            sendError(res, error);
        }
    });

    // Grupos donde está conectado el número del bot, según Z-API.
    router.get("/destinations/whatsapp-groups/available", adminReadLimiter, verificarToken, async (_req, res) => {
        try {
            res.json({ groups: await destinations.discoverWhatsAppGroups() });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/destinations/:id/deactivate", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const destination = await destinations.deactivateDestination(req.params.id);
            if (!destination) return res.status(404).json({ error: "Destino no encontrado o ya inactivo." });
            res.json({ destination });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/destinations/whatsapp-groups", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const destination = await destinations.registerWhatsAppGroup(req.body || {});
            res.status(201).json({ destination });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/schedules", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const result = await scheduler.schedulePublication(req.body || {});
            res.status(result.alreadyExisted ? 200 : 201).json(result);
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/schedules/:id/cancel", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const result = await scheduler.cancelSchedule(req.params.id);
            if (!result.schedule) return res.status(404).json({ error: "Programación no encontrada." });
            if (!result.canceled) return res.status(409).json(result);
            res.json(result);
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get("/daily-rates", adminReadLimiter, verificarToken, async (_req, res) => {
        try {
            res.json({ settings: await rates.getDailyRatesSettings() });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.put("/daily-rates", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            res.json({ settings: await rates.updateDailyRatesSettings(req.body || {}) });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/:id/approve", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const result = await service.resolveDraft(req.params.id, "approve");
            if (!result.asset) return res.status(404).json({ error: "Contenido no encontrado." });
            if (!result.changed) return res.status(409).json({ error: "Este contenido no es un borrador.", asset: result.asset });
            res.json({ asset: result.asset });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/:id/discard", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const result = await service.resolveDraft(req.params.id, "discard");
            if (!result.asset) return res.status(404).json({ error: "Contenido no encontrado." });
            if (!result.changed) return res.status(409).json({ error: "Este contenido no es un borrador.", asset: result.asset });
            res.json({ asset: result.asset });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.get("/:id", adminReadLimiter, verificarToken, async (req, res) => {
        try {
            const asset = await service.getContentAsset(req.params.id);
            if (!asset) return res.status(404).json({ error: "Contenido no encontrado." });
            res.json({ asset });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const asset = await service.createContentAsset(req.body || {});
            res.status(201).json({ asset });
        } catch (error) {
            sendError(res, error);
        }
    });

    router.post("/:id", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const asset = await service.updateContentAsset(req.params.id, req.body || {});
            if (!asset) return res.status(404).json({ error: "Contenido no encontrado." });
            res.json({ asset });
        } catch (error) {
            sendError(res, error);
        }
    });

    return router;
}

module.exports = { createContentLibraryRouter };
