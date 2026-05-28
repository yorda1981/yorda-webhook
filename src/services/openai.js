
require("dotenv").config();

const {
    enviarMensaje
} = require("./zapi");

/**
 * Procesa mensajes entrantes
 */
async function procesarMensaje(
    phone,
    text
) {

    try {

        console.log(
            `🧠 Procesando mensaje para ${phone}: ${text}`
        );

        // =====================================
        // RESPUESTA TEMPORAL
        // =====================================

        const mensajeRespuesta =
            `YordaBot 🤖\n\n` +
            `He recibido tu mensaje:\n"${text}"\n\n` +
            `Estoy procesando los datos para darte una respuesta exacta.`;

        // =====================================
        // ENVÍO
        // =====================================

        await enviarMensaje(
            phone,
            mensajeRespuesta
        );

        console.log(
            `✅ Mensaje enviado a ${phone}`
        );

        return true;

    } catch (error) {

        console.error(
            "❌ Error en procesarMensaje:",
            error.message
        );

        throw error;
    }
}

module.exports = {
    procesarMensaje
};
