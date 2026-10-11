"use strict";

const CHANNELS = Object.freeze({
    WHATSAPP_ADMIN: "whatsapp_admin"
});

// Transformación única del texto que finalmente recibe send-text de Z-API.
// La preview y el transporte comparten esta función para no divergir.
function renderWhatsAppText(value) {
    return String(value ?? "").replace(/\*/g, "").trim();
}

function renderContentForChannel(value, channel = CHANNELS.WHATSAPP_ADMIN) {
    if (channel !== CHANNELS.WHATSAPP_ADMIN) {
        const error = new Error(`Canal no soportado: ${channel}`);
        error.code = "CONTENT_CHANNEL_UNSUPPORTED";
        throw error;
    }
    return {
        channel,
        destination: "ADMIN_PHONE",
        renderedBody: renderWhatsAppText(value)
    };
}

module.exports = { CHANNELS, renderWhatsAppText, renderContentForChannel };
