const axios = require("axios");
require("dotenv").config();

/**
 * Procesa los mensajes entrantes y responde vía Z-API
 */
async function procesarMensaje(phone, text) {
    try {
        console.log(`🧠 Procesando mensaje para ${phone}: ${text}`);

        // 1. CARGA DE VARIABLES DESDE RAILWAY
        // Usamos los nombres exactos que tienes en tu configuración de Variables
        const instance = process.env.ZAPI_INSTANCE;
        const token = process.env.ZAPI_TOKEN;

        // Log de seguridad para verificar la carga en Railway
        if (!instance || !token) {
            console.error("❌ ERROR: ZAPI_INSTANCE o ZAPI_TOKEN no están configurados en Railway.");
            return;
        }

        // 2. CONSTRUCCIÓN DE LA RESPUESTA
        // Aquí es donde luego conectarás tu lógica de OpenAI Assistant
        const mensajeRespuesta = `YordaBot: He recibido tu mensaje: "${text}".\n\nEstoy procesando los datos para darte una respuesta exacta.`;

        // 3. CONFIGURACIÓN DEL ENDPOINT
        // Usamos /send-text que es el estándar más estable de Z-API
        const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;

        // 4. ENVÍO DE LA PETICIÓN
        console.log(`🚀 Enviando respuesta a Z-API...`);
        
        await axios.post(url, {
            phone: phone,
            message: mensajeRespuesta
        });

        console.log(`✅ ¡Mensaje enviado con éxito a ${phone}!`);
        return true;

    } catch (error) {
        // Log detallado para capturar errores de la API o de red
        if (error.response) {
            console.error("❌ Error de Z-API (Respuesta):", error.response.data);
        } else {
            console.error("❌ Error de conexión/lógica:", error.message);
        }
        throw error;
    }
}

// Exportación correcta para que index.js la reconozca
module.exports = { procesarMensaje };
