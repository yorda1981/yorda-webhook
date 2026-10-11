"use strict";

const express = require("express");
const contentLibrary = require("../services/content-library");
const contentSelector = require("../services/content-selector");
const contentPublisher = require("../services/content-publisher");
const contentScheduler = require("../services/content-scheduler");
const contentDestinations = require("../services/content-destinations");
const { verificarToken } = require("../middleware/admin-auth");
const { adminReadLimiter, adminWriteLimiter } = require("../middleware/admin-rate-limiters");

function sendError(res, error) {
    if (error?.code === "CONTENT_LIBRARY_VALIDATION" || error?.code === "CONTENT_SELECTOR_VALIDATION" || error?.code === "CONTENT_PUBLISHER_VALIDATION" || error?.code === "CONTENT_SCHEDULER_VALIDATION" || error?.code === "CONTENT_DESTINATION_VALIDATION") {
        return res.status(400).json({ error: error.message });
    }
    if (error?.code === "CONTENT_DESTINATION_PROVIDER") return res.status(502).json({ error: error.message });
    console.error("❌ Content Library:", error.message);
    return res.status(500).json({ error: "No se pudo completar la operación." });
}

function createContentLibraryRouter({ service = contentLibrary, selector = contentSelector, publisher = contentPublisher, scheduler = contentScheduler, destinations = contentDestinations } = {}) {
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
