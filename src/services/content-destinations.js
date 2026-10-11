"use strict";

const pool = require("../../db");
const { obtenerMetadataGrupo } = require("./zapi");

const DESTINATION_TYPES = Object.freeze({ WHATSAPP_GROUP: "WHATSAPP_GROUP" });

function destinationError(message) {
    const error = new Error(message);
    error.code = "CONTENT_DESTINATION_VALIDATION";
    return error;
}

function normalizeGroupId(value) {
    const groupId = String(value || "").trim();
    if (!groupId || groupId.length > 160 || !groupId.endsWith("-group")) {
        throw destinationError("Identificador de grupo de WhatsApp inválido.");
    }
    return groupId;
}

function normalizeDestinationId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw destinationError("Identificador de destino inválido.");
    return id;
}

function mapDestination(row) {
    if (!row) return null;
    return {
        destinationId: Number(row.id),
        type: row.tipo,
        externalId: row.external_id,
        name: row.nombre,
        active: row.activo,
        validatedAt: row.validado_at
    };
}

async function registerWhatsAppGroup(input, dependencies = {}) {
    const db = dependencies.pool || pool;
    const validateGroup = dependencies.validateGroup || obtenerMetadataGrupo;
    const groupId = normalizeGroupId(input?.groupId);
    const metadata = await validateGroup(groupId);
    if (!metadata || normalizeGroupId(metadata.phone) !== groupId) {
        throw destinationError("El grupo de WhatsApp no existe o no está disponible para esta instancia.");
    }
    const name = String(metadata.subject || input?.name || "").trim().slice(0, 160);
    if (!name) throw destinationError("No fue posible obtener el nombre del grupo.");

    const result = await db.query(`
        WITH saved AS (
            INSERT INTO content_destinations (tipo, external_id, nombre, validado_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (tipo, external_id) DO UPDATE
            SET nombre = EXCLUDED.nombre, activo = TRUE,
                validado_at = NOW(), actualizado_at = NOW()
            RETURNING *
        ), event AS (
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            SELECT 'DESTINATION', id, 'CONTENT_DESTINATION_VALIDATED', 'admin',
                   jsonb_build_object('type', tipo, 'externalId', external_id)
            FROM saved
        )
        SELECT * FROM saved
    `, [DESTINATION_TYPES.WHATSAPP_GROUP, groupId, name]);
    return mapDestination(result.rows[0]);
}

async function getActiveDestination(rawId, db = pool) {
    const id = normalizeDestinationId(rawId);
    const result = await db.query(`
        SELECT * FROM content_destinations WHERE id = $1 AND activo = TRUE LIMIT 1
    `, [id]);
    return mapDestination(result.rows[0]);
}

module.exports = {
    DESTINATION_TYPES,
    normalizeGroupId,
    normalizeDestinationId,
    registerWhatsAppGroup,
    getActiveDestination
};

