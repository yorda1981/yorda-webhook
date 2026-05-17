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

// =========================
// CONFIG
// =========================
const TASA_CUP = parseFloat(process.env.TASA_CUP) || 115;

// =========================
// MEMORIA
// =========================
const mensajesProcesados = new Set();
const buffers = {};

// =========================
// LIMPIEZA RAM
// =========================
setInterval(() => {
  mensajesProcesados.clear();
}, 1000 * 60 * 30);

// =========================
// LOGGER
// =========================
function logger(level, event, meta = {}) {
  console.log(
    `[${level.toUpperCase()}] ${event}`,
    meta
  );
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

        // =========================
        // BUSCAR LEAD EXISTENTE
        // =========================
        models.methodCall(
          "execute_kw",
          [
            ODOO_DB,
            uid,
            ODOO_API_KEY,
            "crm.lead",
            "search",
            [[
              ["partner_name", "=", datos.phone],
              ["type", "=", "opportunity"]
            ]],
            { limit: 1 }
          ],
          (err, leads) => {

            if (err) {
              return logger("error", "ODOO_SEARCH_ERROR", {
                err: err.message
              });
            }

            // Ya existe lead
            if (Array.isArray(leads) && leads.length > 0) {

              logger("info", "ODOO_LEAD_EXISTS", {
                phone: datos.phone,
                leadId: leads[0]
              });

              return;
            }

            // Crear nuevo lead
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
      }
    );

  } catch (e) {

    logger("error", "ODOO_FATAL", {
      err: e.message
    });
  }
}

// =========================
// PROCESAMIENTO PRINCIPAL
// =========================
async function procesarMensaje(phone, textMessage) {

  try {

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

      return;
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
        message: respuestaIA
      },
      timeout: 15000
    });

    logger("info", "MESSAGE_SENT", {
      phone
    });

  } catch (e) {

    logger("error", "PROCESS_MESSAGE_ERROR", {
      message: e.message,
      status: e.response?.status,
      response: e.response?.data
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

    const textMessage =
      String(body.text?.message || "").trim();

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

    if (!textMessage) {
      return res.sendStatus(200);
    }

    const phone =
      String(phoneRaw).replace(/\D/g, "");

    if (phone.length < 10 || phone.length > 15) {

      logger("warn", "INVALID_PHONE", {
        phone
      });

      return res.sendStatus(200);
    }

    // =========================
    // ANTI DUPLICADO
    // =========================
    const fingerprint =
      `${phone}:${textMessage.toLowerCase().trim()}`;

    if (mensajesProcesados.has(fingerprint)) {

      logger("warn", "DUPLICATED_MESSAGE", {
        phone,
        text: textMessage
      });

      return res.sendStatus(200);
    }

    mensajesProcesados.add(fingerprint);

    setTimeout(() => {
      mensajesProcesados.delete(fingerprint);
    }, 1000 * 30);

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
      "etecsa",
      "reales"
    ];

    const esNegocio =
      gatillos.some(g =>
        textMessage.toLowerCase().includes(g)
      );

    if (!esNegocio) {
      return res.sendStatus(200);
    }

    // =========================
    // BUFFER / DEBOUNCE
    // =========================
    if (!buffers[phone]) {
      buffers[phone] = {
        texts: [],
        timer: null
      };
    }

    buffers[phone].texts.push(textMessage);

    clearTimeout(buffers[phone].timer);

    buffers[phone].timer = setTimeout(async () => {

      try {

        const fullText =
          buffers[phone].texts.join(" ");

        delete buffers[phone];

        await procesarMensaje(
          phone,
          fullText
        );

      } catch (e) {

        logger("error", "BUFFER_PROCESS_ERROR", {
          phone,
          err: e.message
        });
      }

    }, 2000);

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
const server = app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `✅ Servidor activo en puerto ${PORT}`
    );
  }
);

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
