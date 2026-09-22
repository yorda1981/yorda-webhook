"use strict";

const pool = require("../../db");
const recuperacion = require("./recuperacion");
const mensajes = require("./recuperacion-mensajes");
const { enviarMensaje } = require("./zapi");

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
        WHERE phone = $1 AND estado IN ('ENVIANDO','ENVIADO')
        ORDER BY id DESC LIMIT 1
    `, [phone]);
    return r.rows[0] || null;
}

/**
 * Reclama un único intento y solo después del COMMIT llama al proveedor.
 * El índice parcial de la migración protege también dos POST concurrentes
 * con idempotency keys distintas para el mismo cliente.
 */
async function enviarRecuperacionManual({ phone, familia, indice, idempotencyKey }, deps = {}) {
    const db = deps.pool || pool;
    const candidatoFn = deps.obtenerCandidato || recuperacion.obtenerCandidatoRecuperablePorTelefono;
    const sendFn = deps.sendFn || enviarMensaje;
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
            VALUES ($1,$2,$3,$4,$5,$6,'ENVIANDO',$7)
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

    // El proveedor se llama únicamente después de haber confirmado ENVIANDO.
    let enviado = false;
    let error = null;
    try {
        enviado = await sendFn(phone, aprobado.mensaje);
        if (!enviado) error = "El proveedor no confirmó el envío.";
    } catch (e) {
        error = e.message || "Error del proveedor WhatsApp.";
    }

    let actualizado;
    try {
        actualizado = await db.query(`
            UPDATE recuperacion_envios
            SET estado = $2,
                enviado_at = CASE WHEN $2 = 'ENVIADO' THEN NOW() ELSE enviado_at END,
                error = $3,
                actualizado_at = NOW()
            WHERE id = $1
            RETURNING id, estado, creado_at, enviado_at, actualizado_at, error
        `, [intento.id, enviado ? "ENVIADO" : "FALLIDO", error]);
    } catch (e) {
        // Z-API pudo aceptar el mensaje, pero no podemos confirmar el estado
        // local. El claim ENVIANDO permanece bloqueado deliberadamente: no se
        // reintenta y se investiga manualmente para evitar un duplicado.
        console.error("❌ Estado ambiguo en recuperación manual:", e.message);
        return {
            ok: false,
            code: "ESTADO_AMBIGUO",
            error: "El mensaje pudo enviarse, pero no se pudo confirmar el estado local. No se reintentó.",
            historial: { id: intento.id, estado: "ENVIANDO", fecha: intento.creado_at, error: e.message }
        };
    }
    if (!actualizado.rows[0]) {
        return {
            ok: false,
            code: "ESTADO_AMBIGUO",
            error: "No se pudo confirmar el estado local. No se reintentó.",
            historial: { id: intento.id, estado: "ENVIANDO", fecha: intento.creado_at, error: "UPDATE sin fila" }
        };
    }
    const historial = resultadoHistorial(actualizado.rows[0] || intento);
    return enviado
        ? { ok: true, code: "ENVIADO", historial, texto: aprobado.mensaje }
        : { ok: false, code: "ENVIO_FALLIDO", error, historial };
}

module.exports = {
    COOLDOWN_HORAS,
    obtenerUltimaRecuperacion,
    enviarRecuperacionManual
};
