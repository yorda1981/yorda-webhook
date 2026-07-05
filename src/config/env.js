require("dotenv").config();

module.exports = {
    ANTHROPIC_API_KEY:  process.env.ANTHROPIC_API_KEY,
    ZAPI_INSTANCE:      process.env.ZAPI_INSTANCE,
    ZAPI_TOKEN:         process.env.ZAPI_TOKEN,
    ZAPI_CLIENT_TOKEN:  process.env.ZAPI_CLIENT_TOKEN,
    PIX_KEY:            process.env.PIX_KEY,
    PIX_HOLDER_NAME:    process.env.PIX_HOLDER_NAME,
    PIX_BANK:           process.env.PIX_BANK,
    PIX_IMAGE_URL:      process.env.PIX_IMAGE_URL,
    PIX_HOLDER_ALIASES: process.env.PIX_HOLDER_ALIASES,
    ADMIN_PHONE:        process.env.ADMIN_PHONE,
    WASCRIPT_TOKEN:     process.env.WASCRIPT_TOKEN
};
