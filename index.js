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
  OPENAI_ASSISTANT_ID,
  ZAPI_INSTANCE,
  ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN,
  ODOO_URL,
  ODOO_DB,
  ODOO_USER,
  ODOO_API_KEY
} = process.env;

// =========================
// VALIDAR ENV
// =========================
const required = [
  "OPENAI_API_KEY",
  "OPENAI_ASSISTANT_ID",
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
// MEMORIA THREADS
// =========================
const threads = new Map();

// =========================
// MENSAJES PROCESADOS
// =========================
const mensajesProcesados = new Set();

setInterval(() => {

  mensajesProcesados.clear();

}, 1000 * 60 * 30);

// =========================
// ODOO
// =========================
function registrarEnOdoo(datos) {

  try {

    const urlLimpia =
      String(ODOO_URL || "")
      .replace(/\/$/, "");

    const common =
      xmlrpc.createSecureClient({
        url:
`${urlLimpia}/xmlrpc/2/common`
      });

    const models =
      xmlrpc.createSecureClient({
        url:
`${urlLimpia}/xmlrpc/2/object`
      });

    common.methodCall(
      "authenticate",

      [
        ODOO_DB,
        ODOO_USER,
        ODOO_API_KEY,
        {}
      ],

      (err, uid) => {

        if (err) {

          return logger(
            "error",
            "ODOO_AUTH_ERROR",
            {
              err: err.message
            }
          );
        }

        if (!uid) {

          return logger(
            "error",
            "ODOO_UID_INVALID"
          );
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
              name:
`WhatsApp: ${datos.phone}`,

              partner_name:
                datos.phone,

              description:
                datos.mensaje,

              type:
                "opportunity"
            }]]
          ],

          (err, res) => {

            if (err) {

              return logger(
                "error",
                "ODOO_CREATE_ERROR",
                {
                  err: err.message
                }
              );
            }

            logger(
              "info",
              "ODOO_LEAD_CREATED",
              {
                id: res,
                phone: datos.phone
              }
            );
          }
        );
      }
    );

  } catch (e) {

    logger(
      "error",
      "ODOO_FATAL",
      {
        err: e.message
      }
    );
  }
}

// =========================
// ENVIAR Z-API
// =========================
async function enviarMensaje(phone, message) {

  await axios({

    method: "post",

    url:
`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,

    headers: {

      "Client-Token":
        ZAPI_CLIENT_TOKEN,

      "Content-Type":
        "application/json"
    },

    data: {
      phone,
      message,
      checkContact: false
    },

    timeout: 15000
  });
}

// =========================
// OPENAI ASSISTANT
// =========================
async function procesarMensaje(phone, textMessage) {

  const headers = {

    Authorization:
`Bearer ${OPENAI_API_KEY}`,

    "Content-Type":
      "application/json",

    "OpenAI-Beta":
      "assistants=v2"
  };

  try {

    let threadId =
      threads.get(phone);

    // =========================
    // CREAR THREAD
    // =========================
    if (!threadId) {

      const thread =
        await axios.post(

        "https://api.openai.com/v1/threads",

        {},

        { headers }
      );

      threadId =
        thread.data.id;

      threads.set(
        phone,
        threadId
      );
    }

    // =========================
    // USER MESSAGE
    // =========================
    await axios.post(

`https://api.openai.com/v1/threads/${threadId}/messages`,

      {
        role: "user",
        content: textMessage
      },

      { headers }
    );

    // =========================
    // RUN
    // =========================
    const run =
      await axios.post(

`https://api.openai.com/v1/threads/${threadId}/runs`,

      {
        assistant_id:
          OPENAI_ASSISTANT_ID
      },

      { headers }
    );

    const runId =
      run.data.id;

    let completed =
      false;

    const startedAt =
      Date.now();

    // =========================
    // POLLING
    // =========================
    while (!completed) {

      if (
        Date.now() -
        startedAt >
        45000
      ) {

        throw new Error(
          "RUN_TIMEOUT"
        );
      }

      await new Promise(
        r =>
          setTimeout(r, 1500)
      );

      const status =
        await axios.get(

`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,

        { headers }
      );

      const state =
        status.data.status;

      if (
        state ===
        "completed"
      ) {

        completed = true;

      } else if (

        [
          "failed",
          "cancelled",
          "expired"
        ].includes(state)

      ) {

        throw new Error(
          `RUN_${state}`
        );
      }
    }

    // =========================
    // LEER RESPUESTA
    // =========================
    const messages =
      await axios.get(

`https://api.openai.com/v1/threads/${threadId}/messages`,

      { headers }
    );

    const respuesta =
      messages.data.data[0]
      ?.content?.[0]
      ?.text?.value
      ?.trim();

    if (!respuesta) {

      throw new Error(
        "EMPTY_RESPONSE"
      );
    }

    // =========================
    // ENVIAR WHATSAPP
    // =========================
    await enviarMensaje(
      phone,
      respuesta
    );

    logger(
      "info",
      "MESSAGE_SENT",
      {
        phone
      }
    );

  } catch (e) {

    logger(
      "error",
      "OPENAI_ERROR",
      {
        phone,
        error: e.message,
        status: e.response?.status,
        response: e.response?.data
      }
    );

  

// =========================
// WEBHOOK
// =========================
app.post("/webhook", async (req, res) => {

  try {

    const body =
      req.body || {};

    const phoneRaw =
      body.phone || "";

    const messageId =
      body.messageId || "";

    const textMessage =
      String(
        body.text?.message || ""
      ).trim();

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

    if (
      mensajesProcesados.has(
        messageId
      )
    ) {

      return res.sendStatus(200);
    }

    mensajesProcesados.add(
      messageId
    );

    setTimeout(() => {

      mensajesProcesados.delete(
        messageId
      );

    }, 1000 * 60 * 5);

    const phone =
      String(phoneRaw)
      .replace(/\D/g, "");

    logger(
      "info",
      "MESSAGE_RECEIVED",
      {
        phone,
        message: textMessage
      }
    );

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
    await procesarMensaje(
      phone,
      textMessage
    );

    return res.sendStatus(200);

  } catch (e) {

    logger(
      "error",
      "WEBHOOK_ERROR",
      {
        error: e.message,
        status: e.response?.status,
        response: e.response?.data
      }
    );

    return res.sendStatus(200);
  }
});

// =========================
// HEALTHCHECK
// =========================
app.get("/", (req, res) => {

  res.send(
    "YordaBot Online"
  );
});

// =========================
// START SERVER
// =========================
const server =
  app.listen(

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
process.on(
  "unhandledRejection",

  (err) => {

    logger(
      "error",
      "UNHANDLED_REJECTION",
      {
        err: err?.message
      }
    );
  }
);

process.on(
  "uncaughtException",

  (err) => {

    logger(
      "error",
      "UNCAUGHT_EXCEPTION",
      {
        err: err?.message
      }
    );
  }
);
