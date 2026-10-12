"use strict";

// ─────────────────────────────────────────────────────────
// PULSO DEL GRUPO (MVP 1 del Director Inteligente de la Comunidad)
//
// Mide el grupo activo del Motor de Marketing y los mensajes que llegan
// al bot, sin publicar nada:
//   - altas y bajas en tiempo real (eventos de participantes de Z-API);
//   - una lectura diaria de participantes que corrige eventos perdidos;
//   - teléfono, tipo y hora de cada mensaje entrante (nunca su contenido).
// Con eso calcula la Métrica Norte (clientes nuevos del grupo), la
// preparación (mensajes por operación), la permanencia y las bajas que
// siguen a cada publicación.
// ─────────────────────────────────────────────────────────

const pool = require("../../db");
const { obtenerMetadataGrupo } = require("./zapi");
const destinations = require("./content-destinations");
const { conLockExclusivo } = require("./job-lock");
const { fechaSaoPaulo, horaSaoPaulo, saoPauloLocalAUTC } = require("../utils/timezone");

const PARTICIPANT_NOTIFICATIONS = Object.freeze({
    GROUP_PARTICIPANT_ADD: "ALTA",
    GROUP_PARTICIPANT_INVITE: "ALTA",
    GROUP_PARTICIPANT_LEAVE: "BAJA",
    GROUP_PARTICIPANT_REMOVE: "BAJA"
});

const SNAPSHOT_HOUR = 6;                  // hora de São Paulo a partir de la cual se lee el grupo
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // la lectura del día se intenta cada hora hasta lograrla
const INBOUND_RETENTION_DAYS = 180;
const LEAVE_WINDOW_HOURS = 24;            // bajas atribuibles a una publicación
const CONVERSATION_LOOKBACK_HOURS = 72;   // mensajes que cuentan para una operación

// Teléfono de un participante tal como lo guarda el Pulso: solo dígitos.
// Un identificador "@lid" no es un teléfono y se conserva tal cual para no
// confundirlo con uno.
function normalizeParticipant(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return null;
    const [user, domain] = raw.split("@");
    if (domain === "lid") return raw;
    return user.replace(/\D/g, "") || null;
}

function inboundMessageType(body) {
    if (body?.image) return "imagen";
    if (body?.document) return "documento";
    if (body?.audio || body?.messageType === "audio" || body?.messageType === "ptt") return "audio";
    if (body?.video) return "video";
    return "texto";
}

function eventTime(body, fallback = new Date()) {
    const ms = Number(body?.momment);
    return Number.isFinite(ms) && ms > 0 ? new Date(ms) : fallback;
}

async function activeGroupId(dependencies, db) {
    const getDefault = dependencies.getDefaultDestination || destinations.getDefaultDestination;
    const destination = await getDefault(db);
    return destination?.type === destinations.DESTINATION_TYPES.WHATSAPP_GROUP ? destination.externalId : null;
}

// Registra un alta o baja y actualiza el estado del participante. Devuelve
// false si el evento ya estaba registrado (callback repetido).
async function applyMemberEvent(client, { groupId, phone, tipo, origen, motivo = null, messageId = null, at }) {
    const inserted = await client.query(`
        INSERT INTO community_member_events (group_id, phone, tipo, origen, motivo, message_id, ocurrido_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (message_id) DO NOTHING
        RETURNING id
    `, [groupId, phone, tipo, origen, motivo, messageId, at]);
    if (!inserted.rows[0]) return false;

    if (tipo === "ALTA") {
        await client.query(`
            INSERT INTO community_members (group_id, phone, joined_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (group_id, phone) DO UPDATE
            SET joined_at = CASE WHEN community_members.activo
                                 THEN community_members.joined_at ELSE EXCLUDED.joined_at END,
                baseline  = CASE WHEN community_members.activo
                                 THEN community_members.baseline ELSE FALSE END,
                activo = TRUE, left_at = NULL, actualizado_at = NOW()
        `, [groupId, phone, at]);
    } else {
        await client.query(`
            UPDATE community_members
            SET activo = FALSE, left_at = $3, actualizado_at = NOW()
            WHERE group_id = $1 AND phone = $2 AND activo = TRUE
        `, [groupId, phone, at]);
    }
    return true;
}

async function inTransaction(db, fn) {
    const client = await db.connect();
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

// Evento de participantes recibido por el webhook. Solo cuenta el grupo
// activo del Motor de Marketing; cualquier otro grupo se ignora.
async function recordGroupNotification(body, dependencies = {}) {
    const tipo = PARTICIPANT_NOTIFICATIONS[body?.notification];
    if (!body?.isGroup || !tipo) return { recorded: 0, ignored: "NOT_PARTICIPANT_EVENT" };
    const db = dependencies.pool || pool;
    const groupId = await activeGroupId(dependencies, db);
    if (!groupId || groupId !== body.phone) return { recorded: 0, ignored: "NOT_ACTIVE_GROUP" };

    const at = eventTime(body);
    const phones = [...new Set((Array.isArray(body.notificationParameters) ? body.notificationParameters : [])
        .map(normalizeParticipant)
        .filter(Boolean))];
    let recorded = 0;
    for (const phone of phones) {
        const messageId = body.messageId ? `${body.messageId}:${phone}` : null;
        const applied = await inTransaction(db, client => applyMemberEvent(client, {
            groupId, phone, tipo, origen: "WEBHOOK", motivo: body.notification, messageId, at
        }));
        if (applied) recorded += 1;
    }
    return { recorded };
}

async function recordInboundMessage(phone, tipo, db = pool) {
    const normalized = String(phone || "").replace(/\D/g, "");
    if (!normalized) return false;
    await db.query("INSERT INTO bot_inbound_messages (phone, tipo) VALUES ($1, $2)", [normalized, tipo]);
    return true;
}

// Lectura diaria: compara los participantes reales con el estado guardado y
// registra como altas/bajas lo que el webhook no informó. La primera
// lectura de un grupo es la línea base: sus miembros entran sin generar altas.
async function takeDailySnapshot(dependencies = {}) {
    const db = dependencies.pool || pool;
    const now = dependencies.now || new Date();
    const groupId = await activeGroupId(dependencies, db);
    if (!groupId) return { skipped: "NO_ACTIVE_DESTINATION" };
    const fecha = fechaSaoPaulo(now);
    const done = await db.query(
        "SELECT 1 FROM community_snapshots WHERE group_id = $1 AND fecha = $2",
        [groupId, fecha]
    );
    if (done.rows[0]) return { skipped: "ALREADY_TAKEN", fecha };

    const metadata = await (dependencies.getGroupMetadata || obtenerMetadataGrupo)(groupId);
    if (!metadata || !Array.isArray(metadata.participants)) {
        throw new Error("Z-API no devolvió los participantes del grupo.");
    }
    const current = new Set(metadata.participants.map(p => normalizeParticipant(p?.phone)).filter(Boolean));

    return inTransaction(db, async client => {
        const previous = await client.query(`
            SELECT tomada_at FROM community_snapshots
            WHERE group_id = $1 ORDER BY fecha DESC LIMIT 1
        `, [groupId]);
        const baseline = !previous.rows[0];
        const activeRows = await client.query(
            "SELECT phone FROM community_members WHERE group_id = $1 AND activo = TRUE",
            [groupId]
        );
        const active = new Set(activeRows.rows.map(row => row.phone));
        const joined = [...current].filter(phone => !active.has(phone));
        const left = [...active].filter(phone => !current.has(phone));

        if (baseline) {
            await client.query(`
                INSERT INTO community_members (group_id, phone, joined_at, baseline)
                SELECT $1, phone, $3, TRUE FROM unnest($2::text[]) AS phone
                ON CONFLICT (group_id, phone) DO UPDATE
                SET activo = TRUE, left_at = NULL, joined_at = EXCLUDED.joined_at,
                    baseline = TRUE, actualizado_at = NOW()
            `, [groupId, joined, now]);
        } else {
            for (const phone of joined) {
                await applyMemberEvent(client, { groupId, phone, tipo: "ALTA", origen: "LECTURA", motivo: "LECTURA_DIARIA", at: now });
            }
        }
        for (const phone of left) {
            await applyMemberEvent(client, { groupId, phone, tipo: "BAJA", origen: "LECTURA", motivo: "LECTURA_DIARIA", at: now });
        }

        const since = previous.rows[0]?.tomada_at || now;
        const counts = await client.query(`
            SELECT COUNT(*) FILTER (WHERE tipo = 'ALTA')::int AS altas,
                   COUNT(*) FILTER (WHERE tipo = 'BAJA')::int AS bajas
            FROM community_member_events
            WHERE group_id = $1 AND ocurrido_at > $2 AND ocurrido_at <= $3
        `, [groupId, since, now]);
        // Altas y bajas desde la lectura anterior, vengan del webhook o de esta lectura.
        const altas = baseline ? 0 : counts.rows[0].altas;
        const bajas = baseline ? 0 : counts.rows[0].bajas;
        await client.query(`
            INSERT INTO community_snapshots (group_id, fecha, miembros, altas, bajas, tomada_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (group_id, fecha) DO NOTHING
        `, [groupId, fecha, current.size, altas, bajas, now]);
        await client.query(
            `DELETE FROM bot_inbound_messages WHERE recibido_at < $1::timestamptz - INTERVAL '${INBOUND_RETENTION_DAYS} days'`,
            [now]
        );
        return { fecha, baseline, miembros: current.size, altas, bajas };
    });
}

function startCommunityPulse(dependencies = {}) {
    const runLocked = dependencies.runLocked || (fn => conLockExclusivo("pulsoGrupo", fn));
    const tick = async () => {
        if (horaSaoPaulo(new Date()) < SNAPSHOT_HOUR) return;
        await runLocked(() => takeDailySnapshot(dependencies));
    };
    const first = setTimeout(tick, dependencies.initialDelayMs ?? 2 * 60 * 1000);
    const timer = setInterval(tick, dependencies.intervalMs || CHECK_INTERVAL_MS);
    for (const handle of [first, timer]) if (typeof handle.unref === "function") handle.unref();
    return { tick, stop: () => { clearTimeout(first); clearInterval(timer); } };
}

function monthBoundsSaoPaulo(now) {
    const [year, month] = fechaSaoPaulo(now).split("-").map(Number);
    const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
    return {
        start: saoPauloLocalAUTC(`${year}-${String(month).padStart(2, "0")}-01T00:00`),
        end: saoPauloLocalAUTC(`${next}-01T00:00`)
    };
}

const toNumber = value => (value === null || value === undefined ? null : Number(value));

async function getPulseMetrics(dependencies = {}) {
    const db = dependencies.pool || pool;
    const now = dependencies.now || new Date();
    const groupId = await activeGroupId(dependencies, db);
    if (!groupId) return { groupId: null };
    const month = monthBoundsSaoPaulo(now);

    const [members, events, retention, newClients, preparation, leavesByPost, snapshots] = await Promise.all([
        db.query(`
            SELECT COUNT(*) FILTER (WHERE activo)::int AS miembros,
                   COUNT(*) FILTER (WHERE activo AND joined_at <= $2::timestamptz - INTERVAL '90 days')::int AS consolidados
            FROM community_members WHERE group_id = $1
        `, [groupId, now]),
        db.query(`
            SELECT COUNT(*) FILTER (WHERE tipo = 'ALTA')::int AS altas,
                   COUNT(*) FILTER (WHERE tipo = 'BAJA')::int AS bajas
            FROM community_member_events
            WHERE group_id = $1 AND ocurrido_at > $2::timestamptz - INTERVAL '7 days'
        `, [groupId, now]),
        // Cohorte que entró hace entre 30 y 60 días: ¿cuántos se quedaron al menos 30?
        db.query(`
            SELECT COUNT(*)::int AS cohorte,
                   COUNT(*) FILTER (WHERE left_at IS NULL OR left_at >= joined_at + INTERVAL '30 days')::int AS retenidos
            FROM community_members
            WHERE group_id = $1 AND baseline = FALSE
              AND joined_at >  $2::timestamptz - INTERVAL '60 days'
              AND joined_at <= $2::timestamptz - INTERVAL '30 days'
        `, [groupId, now]),
        // Métrica Norte: primera operación completada este mes por alguien que
        // ya era miembro del grupo cuando creó esa operación.
        db.query(`
            WITH primeras AS (
                SELECT regexp_replace(phone, '\\D', '', 'g') AS phone,
                       MIN(COALESCE(completed_at, updated_at, created_at)) AS completada,
                       MIN(created_at) AS creada
                FROM operations
                WHERE status = 'completada'
                GROUP BY 1
            )
            SELECT COUNT(*)::int AS clientes
            FROM primeras p
            WHERE p.phone <> ''
              AND p.completada >= $2 AND p.completada < $3
              AND EXISTS (
                  SELECT 1 FROM community_members m
                  WHERE m.group_id = $1 AND m.phone = p.phone AND m.joined_at <= p.creada
              )
        `, [groupId, month.start, month.end]),
        // Preparación: mensajes del cliente en las 72 h anteriores a crear la
        // operación (o desde su operación anterior), solo desde que existe el registro.
        db.query(`
            WITH inicio AS (SELECT MIN(recibido_at) AS desde FROM bot_inbound_messages),
            ops AS (
                SELECT o.id, regexp_replace(o.phone, '\\D', '', 'g') AS phone, o.created_at
                FROM operations o, inicio
                WHERE inicio.desde IS NOT NULL
                  AND o.created_at > $2::timestamptz - INTERVAL '30 days'
                  AND o.created_at >= inicio.desde + INTERVAL '${CONVERSATION_LOOKBACK_HOURS} hours'
                  AND COALESCE(o.origen, '') <> 'dashboard_manual'
            ),
            medidas AS (
                SELECT o.id,
                       (SELECT COUNT(*) FROM bot_inbound_messages b
                        WHERE b.phone = o.phone
                          AND b.recibido_at <= o.created_at
                          AND b.recibido_at > GREATEST(
                              o.created_at - INTERVAL '${CONVERSATION_LOOKBACK_HOURS} hours',
                              COALESCE((SELECT MAX(p.created_at) FROM operations p
                                        WHERE regexp_replace(p.phone, '\\D', '', 'g') = o.phone
                                          AND p.created_at < o.created_at), '-infinity'::timestamp)
                          ))::int AS mensajes,
                       EXISTS (SELECT 1 FROM community_members m
                               WHERE m.group_id = $1 AND m.phone = o.phone
                                 AND m.joined_at <= o.created_at
                                 AND (m.left_at IS NULL OR m.left_at > o.created_at)) AS miembro
                FROM ops o
                WHERE o.phone <> ''
            )
            SELECT COUNT(*)::int AS operaciones,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY mensajes) AS mediana,
                   COUNT(*) FILTER (WHERE miembro)::int AS operaciones_miembros,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY mensajes) FILTER (WHERE miembro) AS mediana_miembros,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY mensajes) FILTER (WHERE NOT miembro) AS mediana_no_miembros
            FROM medidas
        `, [groupId, now]),
        // Bajas en tiempo real (webhook) en las 24 h siguientes a cada publicación.
        db.query(`
            SELECT cp.id, ci.titulo, cp.publicada_at,
                   (SELECT COUNT(*) FROM community_member_events e
                    WHERE e.group_id = $1 AND e.tipo = 'BAJA' AND e.origen = 'WEBHOOK'
                      AND e.ocurrido_at > cp.publicada_at
                      AND e.ocurrido_at <= cp.publicada_at + INTERVAL '${LEAVE_WINDOW_HOURS} hours')::int AS bajas
            FROM content_publications cp
            JOIN content_items ci ON ci.id = cp.content_item_id
            WHERE cp.estado = 'PUBLICADA' AND cp.destino_ref = $1
            ORDER BY cp.publicada_at DESC, cp.id DESC
            LIMIT 10
        `, [groupId]),
        db.query(`
            SELECT to_char(MIN(fecha), 'YYYY-MM-DD') AS desde, to_char(MAX(fecha), 'YYYY-MM-DD') AS ultima
            FROM community_snapshots WHERE group_id = $1
        `, [groupId])
    ]);

    const r = retention.rows[0];
    const p = preparation.rows[0];
    return {
        groupId,
        miembros: members.rows[0].miembros,
        consolidados: members.rows[0].consolidados,
        altas7d: events.rows[0].altas,
        bajas7d: events.rows[0].bajas,
        permanencia30: { cohorte: r.cohorte, retenidos: r.retenidos, porcentaje: r.cohorte ? Math.round(100 * r.retenidos / r.cohorte) : null },
        clientesNuevosMes: newClients.rows[0].clientes,
        preparacion: {
            operaciones: p.operaciones,
            mediana: toNumber(p.mediana),
            operacionesMiembros: p.operaciones_miembros,
            medianaMiembros: toNumber(p.mediana_miembros),
            medianaNoMiembros: toNumber(p.mediana_no_miembros)
        },
        bajasPorPublicacion: leavesByPost.rows.map(row => ({
            publicationId: Number(row.id), titulo: row.titulo, publicadaAt: row.publicada_at, bajas: row.bajas
        })),
        lecturas: { desde: snapshots.rows[0].desde, ultima: snapshots.rows[0].ultima }
    };
}

module.exports = {
    PARTICIPANT_NOTIFICATIONS,
    SNAPSHOT_HOUR,
    INBOUND_RETENTION_DAYS,
    normalizeParticipant,
    inboundMessageType,
    applyMemberEvent,
    recordGroupNotification,
    recordInboundMessage,
    takeDailySnapshot,
    startCommunityPulse,
    monthBoundsSaoPaulo,
    getPulseMetrics
};
