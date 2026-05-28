const axios = require("axios");
require("dotenv").config();

// Importamos los motores que ya limpiamos
const { obtenerTasaBRL } = require("../engines/pricing-engine");
const { calcularOperacion } = require("./calculator");

async function procesarMensaje(phone, text) {
    try {
        console.log(`🧠 Iniciando lógica de OpenAI para: ${text}`);
        
        // AQUÍ VA TU LÓGICA DE OPENAI (Asegúrate de tener la API KEY en Railway)
        // Ejemplo rápido de respuesta para probar:
        const mensajeRespuesta = `Hola! Recibí tu mensaje: "${text}". Estoy procesando las tasas...`;

        // Lógica para enviar a Z-API
        const instance = process.env.INSTANCE_ID;
        const token = process.env.INSTANCE_TOKEN;
        const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-messages`;

        await axios.post(url, {
            phone: phone,
            message: mensajeRespuesta
        });

        return true;
    } catch (error) {
        console.error("❌ Error dentro de procesarMensaje:", error.message);
        throw error;
    }
}

// ESTA LÍNEA ES LA MÁS IMPORTANTE
module.exports = { procesarMensaje };
