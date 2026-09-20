"use strict";

const crypto = require("node:crypto");

// ─────────────────────────────────────────
// SEGURIDAD DEL WEBHOOK ENTRANTE (/webhook)
//
// Z-API NO firma criptográficamente sus webhooks salientes (no hay HMAC,
// no hay header de firma documentado — verificado contra su documentación
// oficial en developer.z-api.io). El "Client-Token" que ya usa
// src/services/zapi.js es al revés: autentica LAS LLAMADAS QUE NOSOTROS
// hacemos hacia la API de Z-API, no algo que Z-API nos reenvíe a nosotros.
// Usarlo como si fuera una firma de entrada sería inventar una garantía
// que el proveedor no da.
//
// La única protección real y compatible con Z-API: la URL del webhook la
// configuramos NOSOTROS en su panel (Z-API exige que sea HTTPS, pero el
// resto de la URL es libre). Por eso el mecanismo es un secreto propio en
// la query string de esa URL — cualquier proveedor que permita configurar
// una URL arbitraria admite este patrón, sin depender de nada que Z-API
// tenga que soportar especialmente.
//
// Activación en 2 pasos, deliberadamente separados para no romper producción:
//   1) Configurar WEBHOOK_SHARED_SECRET en las variables de Railway.
//   2) Actualizar la URL del webhook en el panel de Z-API a:
//        https://<host>/webhook?secret=<el mismo valor>
// Mientras WEBHOOK_SHARED_SECRET no esté configurada, este middleware no
// hace nada — el webhook sigue funcionando exactamente como hoy.
// ─────────────────────────────────────────

function compararSeguro(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function verificarSecretoWebhook(req, res, next) {
    const secretoEsperado = process.env.WEBHOOK_SHARED_SECRET;

    // No configurada todavía -> no-op total (compatibilidad hacia atrás,
    // ver comentario de arriba). Se loggea una sola vez al arrancar el
    // proceso, no en cada request, para no ensuciar los logs.
    if (!secretoEsperado) return next();

    const recibido = req.query?.secret;
    if (typeof recibido === "string" && compararSeguro(recibido, secretoEsperado)) {
        return next();
    }

    console.warn("⚠️ WEBHOOK_REJECTED_SECRET: intento sin secreto válido");
    return res.status(401).json({ error: "No autorizado" });
}

// Valida solo LA FORMA del payload (objeto plano, no array/null/string) —
// nunca el contenido de negocio, eso lo sigue decidiendo el handler tal
// como hoy. Rechaza temprano, antes de que cualquier lógica de negocio
// toque el body.
function validarPayloadWebhook(req, res, next) {
    const body = req.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        console.warn("⚠️ WEBHOOK_REJECTED_PAYLOAD: forma de payload inválida");
        return res.status(400).json({ error: "Payload inválido" });
    }
    next();
}

module.exports = { verificarSecretoWebhook, validarPayloadWebhook, compararSeguro };
