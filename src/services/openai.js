const axios = require("axios");
require("dotenv").config();

// Asegúrate de que estos archivos existan y estén limpios
const { obtenerTasaBRL } = require("../engines/pricing-engine");
const { calcularOperacion } = require("./calculator");

async function procesarMensaje(phone, text) {
    try {
        console.log(`🧠 Procesando mensaje para ${phone}: ${text}`);
        
        // Simulación de respuesta (aquí irá tu lógica de OpenAI)
        const respuesta = `YordaBot: Recibido "${text}".`;

        const instance = process.env.INSTANCE_ID;
        const token = process.env.INSTANCE_TOKEN;
        const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-messages`;

        await axios.post(url, {
            phone: phone,
            message: respuesta
        });

        return true;
    } catch (error) {
        console.error("❌ Error en procesarMensaje:", error.message);
        throw error;
    }
}

// EXPORTACIÓN CON LLAVES
module.exports = { procesarMensaje };
