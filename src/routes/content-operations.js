"use strict";

const express = require("express");
const operations = require("../services/content-operations");
const communityPulse = require("../services/community-pulse");
const { SCHEMA_STATES } = require("../services/schema-status");
const { verificarToken } = require("../middleware/admin-auth");
const { adminReadLimiter, adminWriteLimiter } = require("../middleware/admin-rate-limiters");
const commercialOutbound = require("../services/commercial-outbound-queue");
const automaticMarketer = require("../services/director/automatic-marketer");

// El Pulso nunca debe dejar sin panel al Centro de Operaciones: si falla, se muestra vacío.
async function loadPulse(pulse, schema) {
    if (schema && schema.estado !== SCHEMA_STATES.COMPLETO) return null;
    try {
        return await pulse.getPulseMetrics();
    } catch (error) {
        console.error("❌ Pulso del grupo:", error.message);
        return null;
    }
}

async function loadMarketer(marketer, schema) {
    if (schema && schema.estado !== SCHEMA_STATES.COMPLETO) return null;
    try { return await marketer.getSnapshot(); }
    catch (error) {
        console.error("❌ Estado del marketero:", error.message);
        return null;
    }
}

function createContentOperationsRouter({ service = operations, pulse = communityPulse, outbound = commercialOutbound,
    marketerService = automaticMarketer, getSchedulerStarted = () => false, getSchemaStatus = () => null } = {}) {
    const router = express.Router();
    router.get("/", adminReadLimiter, verificarToken, async (_req, res) => {
        try {
            const schema = getSchemaStatus();
            const [snapshot, pulseMetrics, marketer] = await Promise.all([
                service.getOperationsSnapshot(undefined, {
                    schedulerStarted: Boolean(getSchedulerStarted()),
                    schema
                }),
                loadPulse(pulse, schema),
                loadMarketer(marketerService, schema)
            ]);
            res.json({ operations: { ...snapshot, pulse: pulseMetrics, marketer } });
        } catch (error) {
            console.error("❌ Content Operations:", error.message);
            res.status(500).json({ error: "No se pudo cargar el estado operacional." });
        }
    });
    router.put("/commercial-outbound/settings", adminWriteLimiter, verificarToken, async (req, res) => {
        try { res.json({ settings: await outbound.updateSettings(req.body || {}, "admin") }); }
        catch (error) { res.status(error.code === "COMMERCIAL_QUEUE_VALIDATION" ? 400 : 500).json({ error: error.message }); }
    });
    router.post("/commercial-outbound/:action", adminWriteLimiter, verificarToken, async (req, res) => {
        if (!["pause", "resume"].includes(req.params.action)) return res.status(404).json({ error: "Acción inválida." });
        try { res.json({ settings: await outbound.setPaused(req.params.action === "pause", "admin") }); }
        catch (error) { res.status(500).json({ error: "No se pudo cambiar el estado de la cola." }); }
    });
    router.put("/automatic-marketer/settings", adminWriteLimiter, verificarToken, async (req, res) => {
        try {
            const settings = await marketerService.setSettings(req.body || {}, "admin");
            res.json({ settings });
        } catch (error) {
            res.status(error.status || (error.code === "CONTENT_DIRECTOR_VALIDATION" ? 400 : 500))
                .json({ error: error.message || "No se pudo guardar el marketero automático." });
        }
    });
    return router;
}

module.exports = { createContentOperationsRouter, loadMarketer };

