const axios = require("axios");
require("dotenv").config();

async function procesarMensaje(phone, text) {
    try {
        console.log(`🧠 Procesando mensaje para ${phone}: ${text}`);

        // 1. Respuesta base (luego aquí conectas con OpenAI usando tu OPENAI_API_KEY)
        const mensajeRespuesta = `YordaBot: Recibí tu mensaje "${text}". Procesando...`;

        // 2. USANDO TUS VARIABLES DE RAILWAY EXACTAS
        const instance = process.env.ZAPI_INSTANCE; 
        const token = process.env.ZAPI_TOKEN;
        
        // Construimos la URL con "send-text" que es el estándar de Z-API
        const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;

        // 3. ENVÍO
        await axios.post(url, {
            phone: phone,
            message: mensajeRespuesta
        });

        console.log(`✅ Mensaje enviado a ${phone}`);
        return true;

    } catch (error) {
        if (error.response) {
            console.error("❌ Error de Z-API:", error.response.data);
        } else {
            console.error("❌ Error en procesarMensaje:", error.message);
        }
        throw error;
    }
}

module.exports = { procesarMensaje };
