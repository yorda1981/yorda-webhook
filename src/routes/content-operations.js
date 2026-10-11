"use strict";

const express = require("express");
const operations = require("../services/content-operations");
const { verificarToken } = require("../middleware/admin-auth");
const { adminReadLimiter } = require("../middleware/admin-rate-limiters");

function createContentOperationsRouter({ service = operations, getSchedulerStarted = () => false, getSchemaStatus = () => null } = {}) {
    const router = express.Router();
    router.get("/", adminReadLimiter, verificarToken, async (_req, res) => {
        try {
            res.json({ operations: await service.getOperationsSnapshot(undefined, {
                schedulerStarted: Boolean(getSchedulerStarted()),
                schema: getSchemaStatus()
            }) });
        } catch (error) {
            console.error("❌ Content Operations:", error.message);
            res.status(500).json({ error: "No se pudo cargar el estado operacional." });
        }
    });
    return router;
}

module.exports = { createContentOperationsRouter };

