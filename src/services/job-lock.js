"use strict";

// ─────────────────────────────────────────
// JOB LOCK — exclusión mutua entre instancias para las tareas periódicas
// (Fase 6).
//
// Problema real: Railway puede reiniciar el proceso, y si por accidente
// llegara a haber dos instancias corriendo a la vez, cada setInterval de
// index.js dispararía el mismo job en ambas al mismo tiempo — recordatorio
// doble, mensaje doble, etc.
//
// Solución elegida: advisory lock de PostgreSQL (pg_try_advisory_lock),
// nada de infraestructura nueva. Es la forma más simple posible: un
// entero fijo por job, la base decide atómicamente quién lo tiene. No
// requiere ninguna tabla ni migración — es una primitiva nativa de
// Postgres pensada exactamente para esto.
//
// Si otra instancia ya tiene el lock, esta corrida se salta por completo
// (nunca espera, nunca reintenta a mitad de camino) — el próximo
// setInterval ya lo volverá a intentar.
// ─────────────────────────────────────────

const pool = require("../../db");

// IDs arbitrarios pero FIJOS y ÚNICOS entre sí — si se agrega un job
// nuevo, se le asigna un número que no esté en esta lista, nunca se
// reutiliza uno viejo.
const LOCK_IDS = Object.freeze({
    crmRecordatorios: 911001,
    vipRecalculo: 911002,
    tasasDiarias: 911003,
    saludosMatutinos: 911004,
    entregasAtrasadas: 911005,
    limpiezaWebhookEvents: 911006,
    entregasAvisoManana: 911007,
    entregasAvisoTarde: 911008
});

// Ejecuta fn() solo si ninguna otra instancia tiene el lock de este job en
// este momento. Devuelve true si corrió, false si se saltó (otra instancia
// ya lo estaba corriendo). Nunca revienta: un error de conexión hace que
// se trate como "no se pudo tomar el lock" -> se salta esta corrida.
async function conLockExclusivo(nombreJob, fn) {
    const lockId = LOCK_IDS[nombreJob];
    if (!lockId) throw new Error(`job-lock: "${nombreJob}" no está registrado en LOCK_IDS`);

    let client;
    try {
        client = await pool.connect();
    } catch (e) {
        console.error(`❌ job-lock (${nombreJob}): no se pudo conectar a la DB, se salta esta corrida: ${e.message}`);
        return false;
    }

    try {
        const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS tomado", [lockId]);
        if (!rows[0].tomado) {
            console.log(`⏭️ JOB_SKIPPED_LOCKED: "${nombreJob}" ya lo está corriendo otra instancia`);
            return false;
        }

        try {
            await fn();
            return true;
        } finally {
            await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
        }
    } catch (e) {
        console.error(`❌ job-lock (${nombreJob}):`, e.message);
        return false;
    } finally {
        client.release();
    }
}

module.exports = { conLockExclusivo, LOCK_IDS };
