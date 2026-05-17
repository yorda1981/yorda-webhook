const express = require("express");
const axios = require("axios");
const xmlrpc = require("xmlrpc");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 8080;

const {
  OPENAI_API_KEY,
  ZAPI_INSTANCE,
  ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN,
  ODOO_URL,
  ODOO_DB,
  ODOO_USER,
  ODOO_API_KEY
} = process.env;

// =========================
// VALIDACIÓN ENV
// =========================
const required = [
  "OPENAI_API_KEY",
  "ZAPI_INSTANCE",
  "ZAPI_TOKEN",
  "ZAPI_CLIENT_TOKEN",
  "ODOO_URL",
  "ODOO_DB",
  "ODOO_USER",
  "ODOO_API_KEY"
];

for (const key of required) {
  if (!process.env[key]) {
    console.log(`❌ ENV faltante: ${key}`);
    process.exit(1);
  }
}

const TASA_CUP = parseFloat(process.env.TASA_CUP) || 115;

// =========================
// MEMORIA
// =========================
const mensajesProcesados = new Set();

// Limpieza automática RAM
setInterval(() => {
  mensajesProcesados.clear();
}, 1000 * 60 * 30);

// =========================
// LOGGER
// =========================
function logger(level, event, meta = {}) {
  console.log(JSON.stringify({
    level,
    event,
    timestamp: new Date().toISOString(),
    ...meta
  }));
}

// =========================
// ODOO
// =========================
function registrarEnOdoo(datos) {
  try {
    const urlLimpia = String(ODOO_URL || "").replace(/\/$/, "");

    const common = xmlrpc.createSecureClient({
      url: `${urlLimpia}/xmlrpc/2/common`
    });

    const models = xmlrpc.createSecureClient({
      url: `${urlLimpia}/xmlrpc/2/object`
    });

    common.methodCall(
      "authenticate",
      [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}],
      (err, uid) => {

        if (err) {
          return logger("error", "ODOO_AUTH_ERROR", {
            err: err.message
          });
        }

        if (!uid) {
          return logger("error", "ODOO_UID_INVALID");
        }

        models.methodCall(
          "execute_kw",
          [
            ODOO_DB,
            uid,
            ODOO_API_KEY,
            "crm.lead",
            "create",
            [[{
              name: `WhatsApp: ${datos.phone}`,
              partner_name: datos.phone,
              description: datos.mensaje,
              type: "opportunity"
            }]]
          ],
          (err, res) => {

            if (err) {
              return logger("error", "ODOO_CREATE_ERROR", {
                err: err.message
              });
            }

            logger("info", "ODOO_LEAD_CREATED", {
              id: res,
              phone: datos.phone
            });
          }
        );
      }
    );

  } catch (e) {
    logger("error", "ODOO_FATAL", {
      err: e.message
    });
  }
}

// =========================
// WEBHOOK
// =========================
app.post("/webhook", async (req, res) => {

  try {

    const body = req.body || {};

    const phoneRaw = body.phone || "";
    const messageId = body.messageId || "";
    const textMessage = String(body.text?.message || "").trim();

    const fromMe =
      body.fromMe === true ||
      body.fromMe === "true";

    const isGroup =
      body.isGroup === true ||
      body.isGroup === "true";

    // =========================
    // FILTROS
    // =========================
    if (!phoneRaw) {
      return res.sendStatus(200);
    }

    if (fromMe || isGroup) {
      return res.sendStatus(200);
    }

    if (!messageId) {
      return res.sendStatus(200);
    }

    if (mensajesProcesados.has(messageId)) {
      return res.sendStatus(200);
    }

    mensajesProcesados.add(messageId);

    // limpieza individual
    setTimeout(() => {
      mensajesProcesados.delete(messageId);
    }, 1000 * 60 * 5);

    const phone = String(phoneRaw).replace(/\D/g, "");

    if (phone.length < 10 || phone.length > 15) {

      logger("warn", "INVALID_PHONE", {
        phone
      });

      return res.sendStatus(200);
    }

    if (!textMessage) {
      return res.sendStatus(200);
    }

    // =========================
    // GATILLOS
    // =========================
    const gatillos = [
      "remesa",
      "tasa",
      "envio",
      "recarga",
      "precio",
      "cuanto",
      "hola",
      "pix",
      "usd",
      "cup",
      "mlc",
      "transferencia",
      "cambio",
      "saldo",
      "etecsa"
    ];

    const esNegocio = gatillos.some(g =>
      textMessage.toLowerCase().includes(g)
    );

    if (!esNegocio) {
      return res.sendStatus(200);
    }

    logger("info", "BUSINESS_DETECTED", {
      phone,
      message: textMessage
    });

    // =========================
    // ODOO
    // =========================
    registrarEnOdoo({
      phone,
      mensaje: textMessage
    });

    // =========================
    // OPENAI
    // =========================
    const ai = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              `Eres YordaBot.
              Tasa actual: ${TASA_CUP} CUP por BRL.
              Responde corto, humano y natural.
              Máximo 2 líneas.
              No uses markdown.`
          },
          {
            role: "user",
            content: textMessage.slice(0, 1000)
          }
        ],
        temperature: 0.3
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      }
    );

    const respuestaIA =
      ai.data?.choices?.[0]?.message?.content?.trim();

    if (!respuestaIA) {

      logger("warn", "EMPTY_AI_RESPONSE", {
        phone
      });

      return res.sendStatus(200);
    }

    // =========================
    // Z-API
    // =========================
    await axios({
      method: "post",
      url: `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      headers: {
        "Client-Token": ZAPI_CLIENT_TOKEN,
        "Content-Type": "application/json"
      },
      data: {
        phone,
        message: respuestaIA,
        checkContact: false
      },
      timeout: 15000
    });

    logger("info", "MESSAGE_SENT", {
      phone
    });

    return res.sendStatus(200);

  } catch (e) {

    logger("error", "WEBHOOK_ERROR", {
      message: e.message,
      status: e.response?.status,
      response: e.response?.data
    });

    return res.sendStatus(200);
  }
});

// =========================
// HEALTHCHECK
// =========================
app.get("/", (req, res) => {
  res.send("YordaBot Online");
});

// =========================
// START SERVER
// =========================
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor activo en puerto ${PORT}`);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// =========================
// ANTI-CRASH
// =========================
process.on("unhandledRejection", (err) => {
  logger("error", "UNHANDLED_REJECTION", {
    err: err?.message
  });
});

process.on("uncaughtException", (err) => {
  logger("error", "UNCAUGHT_EXCEPTION", {
    err: err?.message
  });
});
