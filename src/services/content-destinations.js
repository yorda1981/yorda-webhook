"use strict";

const pool = require("../../db");
const { obtenerMetadataGrupo, listarGrupos, obtenerDispositivo } = require("./zapi");

const DESTINATION_TYPES = Object.freeze({ WHATSAPP_GROUP: "WHATSAPP_GROUP" });

const DISCOVERY_PAGE_SIZE = 100;
const DISCOVERY_MAX_PAGES = 10;

// Z-API expone el JID de grupo (120363...@g.us) como "120363...-group";
// los grupos antiguos usan "<creador>-<timestamp>". Se guarda siempre la
// forma de Z-API porque es la que acepta send-text.
const GROUP_ID_PATTERNS = [/^\d{5,}(?:-\d+)?-group$/, /^\d{5,}-\d{5,}$/];

function destinationError(message, code = "CONTENT_DESTINATION_VALIDATION") {
    const error = new Error(message);
    error.code = code;
    return error;
}

function providerError() {
    return destinationError("WhatsApp (Z-API) no respondió. Intenta de nuevo en unos minutos.", "CONTENT_DESTINATION_PROVIDER");
}

function isGroupId(value) {
    return GROUP_ID_PATTERNS.some(pattern => pattern.test(value));
}

function normalizeGroupId(value) {
    let groupId = String(value || "").trim();
    if (groupId.endsWith("@g.us")) groupId = `${groupId.slice(0, -"@g.us".length)}-group`;
    if (!groupId || groupId.length > 160 || !isGroupId(groupId)) {
        throw destinationError("Identificador de grupo de WhatsApp inválido.");
    }
    return groupId;
}

function digits(value) {
    return String(value || "").split("@")[0].replace(/\D/g, "");
}

// El bot pertenece al grupo si su número (o su LID) figura entre los participantes.
function findBotParticipant(metadata, device) {
    const botPhone = digits(device?.phone);
    const botLid = digits(device?.lid);
    if (!botPhone && !botLid) return null;
    const participants = Array.isArray(metadata?.participants) ? metadata.participants : [];
    return participants.find(participant => {
        const phone = digits(participant?.phone);
        const lid = digits(participant?.lid);
        return (botPhone && phone === botPhone) || (botLid && (lid === botLid || phone === botLid));
    }) || null;
}

function evaluateMembership(metadata, device) {
    const participant = findBotParticipant(metadata, device);
    const botIsAdmin = Boolean(participant?.isAdmin || participant?.isSuperAdmin);
    const adminOnly = Boolean(metadata?.adminOnlyMessage || metadata?.isGroupAnnouncement);
    return {
        isMember: Boolean(participant),
        botIsAdmin,
        adminOnly,
        canSend: Boolean(participant) && (!adminOnly || botIsAdmin)
    };
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

async function listDestinations(db = pool) {
    const result = await db.query(`
        SELECT * FROM content_destinations ORDER BY activo DESC, nombre ASC, id ASC
    `);
    return result.rows.map(mapDestination);
}

// Descubre los grupos de la instancia en Z-API y los cruza con los destinos
// ya registrados. No consulta metadata grupo a grupo: la pertenencia se
// valida al seleccionar, para no multiplicar llamadas al proveedor.
async function discoverWhatsAppGroups(dependencies = {}) {
    const db = dependencies.pool || pool;
    const listGroups = dependencies.listGroups || listarGrupos;
    const groups = new Map();
    for (let page = 1; page <= DISCOVERY_MAX_PAGES; page++) {
        const batch = await listGroups({ page, pageSize: DISCOVERY_PAGE_SIZE });
        if (!batch) throw providerError();
        for (const chat of batch) {
            if (chat?.isGroup === false) continue;
            const groupId = String(chat?.phone || "").trim();
            if (!isGroupId(groupId) || groups.has(groupId)) continue;
            groups.set(groupId, { groupId, name: String(chat.name || "").trim() || groupId });
        }
        if (batch.length < DISCOVERY_PAGE_SIZE) break;
    }

    const registered = new Map(
        (await listDestinations(db))
            .filter(destination => destination.type === DESTINATION_TYPES.WHATSAPP_GROUP)
            .map(destination => [destination.externalId, destination])
    );
    return [...groups.values()]
        .map(group => {
            const destination = registered.get(group.groupId);
            return {
                ...group,
                destinationId: destination?.destinationId ?? null,
                registered: Boolean(destination),
                active: Boolean(destination?.active),
                validatedAt: destination?.validatedAt ?? null
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

async function registerWhatsAppGroup(input, dependencies = {}) {
    const db = dependencies.pool || pool;
    const validateGroup = dependencies.validateGroup || obtenerMetadataGrupo;
    const getDevice = dependencies.getDevice || obtenerDispositivo;
    const groupId = normalizeGroupId(input?.groupId);
    const [metadata, device] = await Promise.all([validateGroup(groupId), getDevice()]);
    if (!device?.phone) throw providerError();
    if (!metadata || normalizeGroupId(metadata.phone) !== groupId) {
        throw destinationError("El grupo de WhatsApp no existe o no está disponible para esta instancia.");
    }
    const membership = evaluateMembership(metadata, device);
    if (!membership.isMember) {
        throw destinationError("El número del bot no es participante de este grupo.");
    }
    if (!membership.canSend) {
        throw destinationError("En este grupo solo los administradores pueden enviar mensajes y el bot no es administrador.");
    }
    const name = String(metadata.subject || "").trim().slice(0, 160);
    if (!name) throw destinationError("No fue posible obtener el nombre del grupo.");

    // Un único destino activo: activar un grupo reemplaza al anterior en la
    // misma transacción (garantizado también por uq_content_destinations_single_active).
    const client = await db.connect();
    let result;
    try {
        await client.query("BEGIN");
        await client.query("LOCK TABLE content_destinations IN SHARE ROW EXCLUSIVE MODE");
        await client.query(`
            WITH replaced AS (
                UPDATE content_destinations
                SET activo = FALSE, actualizado_at = NOW()
                WHERE activo = TRUE AND NOT (tipo = $1 AND external_id = $2)
                RETURNING *
            )
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            SELECT 'DESTINATION', id, 'CONTENT_DESTINATION_DEACTIVATED', 'admin',
                   jsonb_build_object('type', tipo, 'externalId', external_id, 'replacedBy', $2::text)
            FROM replaced
        `, [DESTINATION_TYPES.WHATSAPP_GROUP, groupId]);
        result = await client.query(`
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
                       jsonb_build_object('type', tipo, 'externalId', external_id, 'botIsAdmin', $4::boolean)
                FROM saved
            )
            SELECT * FROM saved
        `, [DESTINATION_TYPES.WHATSAPP_GROUP, groupId, name, membership.botIsAdmin]);
        await client.query("COMMIT");
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
    return mapDestination(result.rows[0]);
}

async function deactivateDestination(rawId, db = pool) {
    const id = normalizeDestinationId(rawId);
    const result = await db.query(`
        WITH updated AS (
            UPDATE content_destinations
            SET activo = FALSE, actualizado_at = NOW()
            WHERE id = $1 AND activo = TRUE
            RETURNING *
        ), event AS (
            INSERT INTO content_events (entity_type, entity_id, event_type, actor, datos)
            SELECT 'DESTINATION', id, 'CONTENT_DESTINATION_DEACTIVATED', 'admin',
                   jsonb_build_object('type', tipo, 'externalId', external_id)
            FROM updated
        )
        SELECT * FROM updated
    `, [id]);
    return mapDestination(result.rows[0]);
}

// Destino que usan automáticamente todas las publicaciones sin destino explícito.
async function getDefaultDestination(db = pool) {
    const result = await db.query(`
        SELECT * FROM content_destinations WHERE activo = TRUE ORDER BY id LIMIT 1
    `);
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
    evaluateMembership,
    listDestinations,
    discoverWhatsAppGroups,
    registerWhatsAppGroup,
    deactivateDestination,
    getDefaultDestination,
    getActiveDestination
};

