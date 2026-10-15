require("dotenv").config();

module.exports = {
    OPENAI_API_KEY:     process.env.OPENAI_API_KEY,
    ZAPI_INSTANCE:      process.env.ZAPI_INSTANCE,
    ZAPI_TOKEN:         process.env.ZAPI_TOKEN,
    ZAPI_CLIENT_TOKEN:  process.env.ZAPI_CLIENT_TOKEN,
    // Opcional; si no se define, el número público se obtiene del dispositivo
    // Z-API conectado (nunca se sustituye por ADMIN_PHONE).
    WHATSAPP_OFFICIAL_NUMBER: process.env.WHATSAPP_OFFICIAL_NUMBER || null,
    PIX_KEY:            process.env.PIX_KEY,
    PIX_HOLDER_NAME:    process.env.PIX_HOLDER_NAME,
    PIX_BANK:           process.env.PIX_BANK,
    PIX_IMAGE_URL:      process.env.PIX_IMAGE_URL,
    PIX_HOLDER_ALIASES: process.env.PIX_HOLDER_ALIASES,
    ADMIN_PHONE:        process.env.ADMIN_PHONE,
    WASCRIPT_TOKEN:     process.env.WASCRIPT_TOKEN,
    // Contacto en Cuba encargado de realizar las entregas en efectivo —
    // recibe la misma notificación/ID que el admin cuando se crea una
    // entrega nueva (CRM de Entregas). Configurable por variable de
    // Entorno: no hay fallback seguro para este destinatario. Si falta,
    // el CRM avisará únicamente al admin y dejará la ausencia visible.
    ENTREGA_CONTACT_PHONE: process.env.ENTREGA_CONTACT_PHONE || null,
    // Director IA: genera borradores diarios en la Biblioteca. Se desactiva
    // con DIRECTOR_ENABLED=false; los modelos se pueden cambiar sin tocar código.
    // Su criterio comercial (mezcla, umbral, máximo) vive en director_config.
    DIRECTOR_ENABLED: process.env.DIRECTOR_ENABLED !== "false",
    DIRECTOR_MODEL_SELECT: process.env.DIRECTOR_MODEL_SELECT || "gpt-4o-mini",
    DIRECTOR_MODEL_WRITE: process.env.DIRECTOR_MODEL_WRITE || "gpt-4o"
};

if (!module.exports.ENTREGA_CONTACT_PHONE) {
    console.warn("⚠️ ENTREGA_CONTACT_PHONE no configurado: no se enviarán avisos al contacto de Entregas");
}
