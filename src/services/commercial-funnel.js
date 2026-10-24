"use strict";

const crypto = require("node:crypto");
const pool = require("../../db");

function warn(event, error) {
    console.warn(`⚠️ Embudo comercial: ${event} no pudo registrarse: ${error?.message || error}`);
}

async function crearCotizacion({ phone, tipo, monto, salida = null, source = "WHATSAPP" }, db = pool) {
    if (!phone || !tipo) return null;
    const quoteId = crypto.randomUUID();
    let client;
    try {
        client = await db.connect();
        await client.query("BEGIN");
        const exists = await client.query("SELECT 1 FROM customers WHERE phone=$1 FOR UPDATE", [phone]);
        if (!exists.rows.length) throw new Error("cliente no encontrado");
        await client.query(`INSERT INTO commercial_funnel_quotes
            (quote_id,phone,quote_type,amount,output_amount,source)
            VALUES ($1,$2,$3,$4,$5,$6)`, [quoteId, phone, String(tipo).slice(0, 40), monto == null ? null : Number(monto), salida == null ? null : Number(salida), String(source).slice(0, 30)]);
        await client.query("UPDATE customers SET current_quote_id=$2 WHERE phone=$1", [phone, quoteId]);
        await client.query("COMMIT");
        return quoteId;
    } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        warn("cotización", error);
        return null;
    } finally {
        client?.release?.();
    }
}

async function marcarAceptacion(phone, db = pool) {
    try {
        const r = await db.query(`UPDATE commercial_funnel_quotes q SET accepted_at=COALESCE(q.accepted_at,NOW())
            FROM customers c WHERE c.phone=$1 AND q.quote_id=c.current_quote_id AND q.phone=c.phone
            RETURNING q.quote_id`, [phone]);
        return r.rows[0]?.quote_id || null;
    } catch (error) { warn("aceptación", error); return null; }
}

async function iniciarEnvioPix(phone, db = pool) {
    try {
        const r = await db.query(`UPDATE commercial_funnel_quotes q SET
                accepted_at=COALESCE(q.accepted_at,NOW()),
                pix_requested_at=COALESCE(q.pix_requested_at,NOW()),
                pix_provider_last_status='UNKNOWN'
            FROM customers c WHERE c.phone=$1 AND q.quote_id=c.current_quote_id AND q.phone=c.phone
            RETURNING q.quote_id`, [phone]);
        return r.rows[0]?.quote_id || null;
    } catch (error) { warn("inicio de solicitud PIX", error); return null; }
}

async function registrarPixProveedor(phone, results, db = pool) {
    const states = Array.isArray(results) ? results : [];
    // El transporte existente reduce timeout, desconexión y rechazo del
    // proveedor al mismo `false`; sin una respuesta tipada no afirmamos
    // rechazo: queda UNKNOWN. true solo significa respuesta HTTP aceptada.
    const status = !states.length ? "UNKNOWN"
        : states.every(v => v === true) ? "ACCEPTED"
            : states.some(v => v === true) ? "PARTIAL" : "UNKNOWN";
    try {
        const r = await db.query(`UPDATE commercial_funnel_quotes q SET
                pix_provider_last_status=$2::varchar,
                pix_provider_accepted_at=CASE WHEN $3::boolean THEN COALESCE(q.pix_provider_accepted_at,NOW()) ELSE q.pix_provider_accepted_at END
            FROM customers c WHERE c.phone=$1 AND q.quote_id=c.current_quote_id AND q.phone=c.phone
            RETURNING q.quote_id`, [phone, status, status === "ACCEPTED"]);
        return { quoteId: r.rows[0]?.quote_id || null, providerStatus: status };
    } catch (error) { warn("resultado PIX", error); return { quoteId: null, providerStatus: status }; }
}

async function registrarComprobante(phone, db = pool) {
    let client;
    try {
        client = await db.connect();
        await client.query("BEGIN");
        // Si existen varias cotizaciones con PIX solicitado y sin operación,
        // no adivinar cuál originó el comprobante. Se conserva el comprobante
        // en el flujo operativo, pero queda sin atribución a una cotización.
        const open = await client.query(`SELECT q.quote_id FROM commercial_funnel_quotes q
            WHERE q.phone=$1 AND q.pix_requested_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.quote_id=q.quote_id)
            ORDER BY q.pix_requested_at DESC LIMIT 2 FOR UPDATE OF q`, [phone]);
        if (open.rows.length !== 1) {
            await client.query("UPDATE customers SET current_quote_id=NULL WHERE phone=$1", [phone]);
            await client.query("COMMIT");
            return null;
        }
        const quoteId = open.rows[0].quote_id;
        await client.query("UPDATE commercial_funnel_quotes SET receipt_received_at=COALESCE(receipt_received_at,NOW()) WHERE quote_id=$1", [quoteId]);
        await client.query("UPDATE customers SET current_quote_id=$2 WHERE phone=$1", [phone, quoteId]);
        await client.query("COMMIT");
        return quoteId;
    } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        warn("comprobante", error);
        return null;
    } finally { client?.release?.(); }
}

async function obtenerResumen(dias = 30, db = pool) {
    const ventana = Math.max(1, Math.min(365, Number(dias) || 30));
    const r = await db.query(`SELECT COUNT(*)::int AS cotizaciones,
        COUNT(*) FILTER (WHERE q.accepted_at IS NOT NULL)::int AS aceptaron,
        COUNT(*) FILTER (WHERE q.pix_requested_at IS NOT NULL)::int AS pix_solicitado,
        COUNT(*) FILTER (WHERE q.pix_provider_accepted_at IS NOT NULL)::int AS pix_aceptado_proveedor,
        COUNT(*) FILTER (WHERE q.pix_provider_last_status IN ('PARTIAL','FAILED','UNKNOWN'))::int AS pix_resultado_no_confirmado,
        COUNT(*) FILTER (WHERE q.receipt_received_at IS NOT NULL)::int AS comprobantes,
        COUNT(o.id)::int AS operaciones_creadas,
        COUNT(o.id) FILTER (WHERE o.confirmed_at IS NOT NULL AND o.status IN ('confirmada','completada'))::int AS operaciones_confirmadas,
        COUNT(o.id) FILTER (WHERE o.status='completada' AND o.completed_at IS NOT NULL AND o.completed_at >= o.confirmed_at)::int AS completadas,
        COUNT(o.id) FILTER (WHERE o.status='cancelada' OR o.cancelada_at IS NOT NULL)::int AS canceladas,
        COUNT(*) FILTER (WHERE q.created_at < NOW()-INTERVAL '24 hours'
            AND q.accepted_at IS NULL AND q.pix_requested_at IS NULL AND q.receipt_received_at IS NULL
            AND o.id IS NULL)::int AS sin_avance_observable_24h,
        MIN(q.created_at) AS seguimiento_desde
        FROM commercial_funnel_quotes q LEFT JOIN operations o ON o.quote_id=q.quote_id
        WHERE q.created_at >= NOW()-($1::int * INTERVAL '1 day')`, [ventana]);
    return { ...r.rows[0], trackedFunnel: true, cohortDays: ventana };
}

module.exports = {
    crearCotizacion,
    marcarAceptacion,
    iniciarEnvioPix,
    registrarPixProveedor,
    registrarComprobante,
    obtenerResumen
};
