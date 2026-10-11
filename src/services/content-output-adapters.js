"use strict";

const { enviarMensaje } = require("./zapi");
const { getAdminPhone } = require("../flows/shared");
const destinations = require("./content-destinations");

async function resolveOutputDestination(input, dependencies = {}) {
    const adminPhone = dependencies.adminPhone !== undefined ? dependencies.adminPhone : getAdminPhone();
    if (input?.destinationId === undefined || input?.destinationId === null || input?.destinationId === "") {
        if (!adminPhone) return null;
        return { type: "WHATSAPP_ADMIN", channel: "whatsapp_admin", reference: "ADMIN_PHONE", address: adminPhone };
    }
    const destination = await (dependencies.getDestination || destinations.getActiveDestination)(
        input.destinationId,
        dependencies.pool
    );
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

