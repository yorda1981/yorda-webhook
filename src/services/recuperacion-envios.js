"use strict";

const pool = require("../../db");
const recuperacion = require("./recuperacion");
const mensajes = require("./recuperacion-mensajes");
const commercialQueue = require("./commercial-outbound-queue");

const COOLDOWN_HORAS = 24;

function resultadoHistorial(row) {
    if (!row) return null;
    return {
        id: row.id,
        estado: row.estado,
        fecha: row.enviado_at || row.actualizado_at || row.creado_at,
        error: row.error || null
    };
}

async function obtenerUltimaRecuperacion(phone, executor = pool) {
    const r = await executor.query(`
        SELECT id, estado, creado_at, enviado_at, actualizado_at, error
        FROM recuperacion_envios
        WHERE phone = $1
        ORDER BY id DESC
        LIMIT 1
    `, [phone]);
    return resultadoHistorial(r.rows[0]);
}

async function buscarBloqueoActual(phone, executor) {
    const r = await executor.query(`
        SELECT id, estado, creado_at, enviado_at, actualizado_at, error
        FROM recuperacion_envios
        WHERE phone = $1 AND estado IN ('EN_COLA','ENVIANDO','ENVIADO','INCIERTO')
        ORDER BY id DESC LIMIT 1
    `, [phone]);
    return r.rows[0] || null;
}

/**
 * Registra el intento y lo agrega a la cola compartida; solo el scheduler
 * puede llamar al proveedor tras revalidar sus condiciones.
 * El índice parcial de la migración protege también dos POST concurrentes
 * con idempotency keys distintas para el mismo cliente.
 */
async function enviarRecuperacionManual({ phone, familia, indice, idempotencyKey, textoAprobado = null, metadata = {} }, deps = {}) {
    const db = deps.pool || pool;
    const candidatoFn = deps.obtenerCandidato || recuperacion.obtenerCandidatoRecuperablePorTelefono;
    if (!phone || !idempotencyKey || String(idempotencyKey).length > 120) {
        return { ok: false, code: "PETICION_INVALIDA", error: "Faltan teléfono o idempotency key válida." };
    }
    if (!Number.isInteger(indice) || typeof familia !== "string") {
        return { ok: false, code: "VARIANTE_INVALIDA", error: "La variante aprobada no es válida." };
    }

    let client;
    let intento;
    let aprobado;
    try {
        client = await db.connect();
        await client.query("BEGIN");

        // La misma fuente de verdad del listado/preview, revalidada dentro de
        // la transacción justo antes de reclamar el intento.
        const candidato = await candidatoFn(phone, client);
        if (!candidato) {
            await client.query("ROLLBACK");
            return { ok: false, code: "NO_ELEGIBLE", error: "La situación del cliente cambió: ya no es recuperable." };
        }
        aprobado = mensajes.construirVarianteAprobada(candidato, { familia, indice });
        if (!aprobado) {
            await client.query("ROLLBACK");
            return { ok: false, code: "VARIANTE_INVALIDA", error: "La variante ya no pertenece al candidato o al motor actual." };
        }
        const texto = textoAprobado === null || textoAprobado === undefined
            ? aprobado.mensaje : String(textoAprobado).trim().slice(0, 2000);
        if (!texto) {
            await client.query("ROLLBACK");
            return { ok: false, code: "MENSAJE_INVALIDO", error: "El mensaje aprobado está vacío." };
        }
        aprobado = { ...aprobado, mensaje: texto };

        // Conserva todo el historial, pero libera el bloqueo lógico de éxitos
        // anteriores al cooldown para que el cliente pueda volver a elegirse.
        await client.query(`
            UPDATE recuperacion_envios
            SET estado = 'EXPIRADO', actualizado_at = NOW()
            WHERE phone = $1
              AND estado = 'ENVIADO'
              AND enviado_at <= NOW() - INTERVAL '${COOLDOWN_HORAS} hours'
        `, [phone]);

        const existente = await client.query(`
            SELECT id, phone, familia, variante_indice, texto, estado,
                   creado_at, enviado_at, actualizado_at, error
            FROM recuperacion_envios
            WHERE idempotency_key = $1
            LIMIT 1
        `, [String(idempotencyKey)]);
        if (existente.rows[0]) {
            await client.query("ROLLBACK");
            const row = existente.rows[0];
            const mismaSolicitud = row.phone === phone
                && row.familia === aprobado.familia
                && Number(row.variante_indice) === aprobado.indice
                && row.texto === aprobado.mensaje;
            if (!mismaSolicitud) {
                return {
                    ok: false,
                    code: "IDEMPOTENCY_CONFLICT",
                    error: "La idempotency key ya pertenece a otra solicitud."
                };
            }
            return {
                ok: row.estado === "ENVIADO",
                code: row.estado === "ENVIADO" ? "YA_ENVIADO" : "INTENTO_EXISTENTE",
                historial: resultadoHistorial(row)
            };
        }

        const insertado = await client.query(`
            INSERT INTO recuperacion_envios
                (phone, familia, variante_indice, tono, tipo_favorito, texto, estado, idempotency_key)
            VALUES ($1,$2,$3,$4,$5,$6,'EN_COLA',$7)
            RETURNING id, estado, creado_at, enviado_at, actualizado_at, error
        `, [phone, aprobado.familia, aprobado.indice, aprobado.tono,
            candidato.tipoFavorito || null, aprobado.mensaje, String(idempotencyKey)]);
        intento = insertado.rows[0];
        await client.query("COMMIT");
    } catch (e) {
        try { if (client) await client.query("ROLLBACK"); } catch (_) {}
        // Un conflicto del índice parcial significa que otra request ya
        // reclamó el teléfono; nunca se intenta enviar desde esta request.
        if (e.code === "23505") {
            try {
                const activo = await buscarBloqueoActual(phone, db);
                return { ok: false, code: activo?.estado === "ENVIADO" ? "COOLDOWN" : "EN_CURSO", historial: resultadoHistorial(activo) };
            } catch (_) {}
        }
        console.error("❌ Error preparando recuperación manual:", e.message);
        return { ok: false, code: "ERROR_DB", error: "No se pudo registrar el intento." };
    } finally {
        if (client) client.release();
    }

    const queued = await (deps.commercialQueue || commercialQueue).enqueue({
        phone, source: "RECUPERACION", reason: `campana_${familia}`,
        strategy: `recuperacion_${familia}_${indice}`, content: aprobado.mensaje,
        idempotencyKey: `recovery-${idempotencyKey}`, recoveryAttemptId: intento.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        metadata: { ...metadata, familia: aprobado.familia, indice: aprobado.indice, operatorApproved: true }
    }, { pool: db });
    if (!queued.queued) {
        const state = ["OPTED_OUT", "HUMAN_PAUSE", "NO_VERIFIABLE_MARKETING_CONSENT", "CUSTOMER_ALREADY_QUEUED", "BLOCKED_NUMBER"].includes(queued.code) ? "CANCELADO" : "FALLIDO";
        await db.query("UPDATE recuperacion_envios SET estado=$2,error=$3,actualizado_at=NOW() WHERE id=$1 AND estado='EN_COLA'",
            [intento.id, state, queued.code]).catch(() => {});
        return { ok: false, code: queued.code, error: "No se pudo agregar el contacto a la cola comercial.", historial: { ...resultadoHistorial(intento), estado: state } };
    }
    const queuedRow = await db.query(`SELECT id,estado,creado_at,enviado_at,actualizado_at,error
        FROM recuperacion_envios WHERE id=$1`, [intento.id]);
    return { ok: true, code: "EN_COLA", queueId: queued.id, historial: resultadoHistorial(queuedRow.rows[0] || intento), texto: aprobado.mensaje };
}

module.exports = {
    COOLDOWN_HORAS,
    obtenerUltimaRecuperacion,
    enviarRecuperacionManual
};
