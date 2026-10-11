"use strict";

const { enviarMensaje } = require("./zapi");
const destinations = require("./content-destinations");

// Sin destino explícito se usa el destino activo del Motor de Marketing.
// Si no hay ninguno devuelve null: el Publicador responde DESTINATION_NOT_FOUND
// y no envía. Nunca se redirige al WhatsApp administrativo.
async function resolveOutputDestination(input, dependencies = {}) {
    const destination = input?.destinationId === undefined || input?.destinationId === null || input?.destinationId === ""
        ? await (dependencies.getDefaultDestination || destinations.getDefaultDestination)(dependencies.pool)
        : await (dependencies.getDestination || destinations.getActiveDestination)(input.destinationId, dependencies.pool);
    if (!destination) return null;
    if (destination.type === destinations.DESTINATION_TYPES.WHATSAPP_GROUP) {
        return { type: destination.type, channel: "whatsapp_group", reference: destination.externalId, address: destination.externalId };
    }
    return null;
}

async function sendToDestination(destination, body, dependencies = {}) {
    const sendFn = dependencies.sendFn || enviarMensaje;
    return Boolean(await sendFn(destination.address, body));
}

module.exports = { resolveOutputDestination, sendToDestination };

