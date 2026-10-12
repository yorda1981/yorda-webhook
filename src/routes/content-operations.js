"use strict";

const express = require("express");
const operations = require("../services/content-operations");
const communityPulse = require("../services/community-pulse");
const { SCHEMA_STATES } = require("../services/schema-status");
const { verificarToken } = require("../middleware/admin-auth");
const { adminReadLimiter } = require("../middleware/admin-rate-limiters");

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

function createContentOperationsRouter({ service = operations, pulse = communityPulse, getSchedulerStarted = () => false, getSchemaStatus = () => null } = {}) {
    const router = express.Router();
    router.get("/", adminReadLimiter, verificarToken, async (_req, res) => {
        try {
            const schema = getSchemaStatus();
            const [snapshot, pulseMetrics] = await Promise.all([
                service.getOperationsSnapshot(undefined, {
                    schedulerStarted: Boolean(getSchedulerStarted()),
                    schema
                }),
                loadPulse(pulse, schema)
            ]);
            res.json({ operations: { ...snapshot, pulse: pulseMetrics } });
        } catch (error) {
            console.error("❌ Content Operations:", error.message);
            res.status(500).json({ error: "No se pudo cargar el estado operacional." });
        }
    });
    return router;
}

module.exports = { createContentOperationsRouter };

