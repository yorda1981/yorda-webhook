require("dotenv").config();

module.exports = {

  OPENAI_API_KEY:
    process.env.OPENAI_API_KEY,

  OPENAI_ASSISTANT_ID:
    process.env.OPENAI_ASSISTANT_ID,

  ZAPI_INSTANCE:
    process.env.ZAPI_INSTANCE,

  ZAPI_TOKEN:
    process.env.ZAPI_TOKEN,

  ZAPI_CLIENT_TOKEN:
    process.env.ZAPI_CLIENT_TOKEN,

  ODOO_URL:
    process.env.ODOO_URL,

  ODOO_DB:
    process.env.ODOO_DB,

  ODOO_USER:
    process.env.ODOO_USER,

  ODOO_API_KEY:
    process.env.ODOO_API_KEY,

  REDIS_URL:
    process.env.REDIS_URL
};
