const express = require("express");
const axios = require("axios");
const xmlrpc = require("xmlrpc");
const Redis = require("ioredis");
const rateLimit = require("express-rate-limit");

require("dotenv").config();

const app = express();

app.use(express.json({ limit: "10mb" }));

app.set("trust proxy", 1);

app.disable("x-powered-by");

// =========================
// REDIS
// =========================
let redis = null;

if (process.env.REDIS_URL) {

  redis = new Redis(process.env.REDIS_URL);

  redis.on("connect", () => {

    console.log("✅ Redis conectado");
  });

  redis.on("error", (err) => {

    console.log(
      "⚠️ Redis error:",
      err.message
    );
  });

} else {

  console.log(
    "⚠️ REDIS_URL no configurado. Continuando sin Redis."
  );
}

// =========================
// RATE LIMIT
// =========================
app.use(

  rateLimit({

    windowMs: 60 * 1000,

    max: 120
  })
);

// =========================
// ENV
// =========================
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

    console.log(
      `❌ ENV faltante: ${key}`
    );

    process.exit(1);
  }
}

// =========================
// LOGGER
// =========================
function logger(level, event, meta = {}) {

  console.log(

    JSON.stringify({

      level,
      event,

      timestamp:
        new Date()
        .toISOString(),

      ...meta
    })
  );
}

// =========================
// MEMORIA
// =========================
const threads = new Map();

const mensajesProcesados =
  new Set();

const humanTakeover =
  {};

const stageCache =
  {};

const buffers =
  {};

// =========================
// ODOO UID CACHE
// =========================
let odooUid = null;

// =========================
// LIMPIAR DUPLICADOS
// =========================
setInterval(() => {

  mensajesProcesados.clear();

}, 1000 * 60 * 30);

// =========================
// AUTENTICAR ODOO
// =========================
async function getOdooUid() {

  if (odooUid) {

    return odooUid;
  }

  return new Promise((resolve, reject) => {

    const common =
      xmlrpc.createSecureClient({

        url:
`${ODOO_URL.replace(/\/$/, "")}/xmlrpc/2/common`
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

          return reject(err);
        }

        odooUid = uid;

        resolve(uid);
      }
    );
  });
}

// =========================
// DETECTAR ETAPA
// =========================
function detectarEtapa(texto) {

  const t =
    String(texto || "")
    .toLowerCase();

  if (

    t.includes("pagué") ||
    t.includes("pague") ||
    t.includes("comprobante") ||
    t.includes("listo")

  ) {

    return "Pago confirmado";
  }

  if (

    t.includes("finalizado") ||
    t.includes("entregado")

  ) {

    return "Finalizado";
  }

  return "Tasa enviada";
}

// =========================
// STAGE ID
// =========================
async function obtenerStageId(
  models,
  uid,
  nombre
) {

  if (stageCache[nombre]) {

    return stageCache[nombre];
  }

  return new Promise((resolve, reject) => {

    models.methodCall(

      "execute_kw",

      [

        ODOO_DB,
        uid,
        ODOO_API_KEY,

        "crm.stage",
        "search_read",

        [[
          ["name", "=", nombre]
        ]],

        {
          fields: ["id"],
          limit: 1
        }
      ],

      (err, res) => {

        if (err) {

          return reject(err);
        }

        if (
          !res ||
          !res.length
        ) {

          return resolve(null);
        }

        const id =
          res[0].id;

        stageCache[nombre] =
          id;

        resolve(id);
      }
    );
  });
}

// =========================
// MOVER ETAPA
// =========================
async function moverLeadEtapa(
  models,
  uid,
  leadId,
  etapa
) {

  try {

    const stageId =
      await obtenerStageId(
        models,
        uid,
        etapa
      );

    if (!stageId) {

      return;
    }

    models.methodCall(

      "execute_kw",

      [

        ODOO_DB,
        uid,
        ODOO_API_KEY,

        "crm.lead",
        "write",

        [
          [leadId],
          {
            stage_id:
              stageId
          }
        ]
      ],

      (err) => {

        if (err) {

          logger(
            "error",
            "MOVE_STAGE_ERROR",
            {
              err:
                err.message
            }
          );
        }
      }
    );

  } catch (e) {

    logger(
      "error",
      "MOVE_STAGE_FATAL",
      {
        err:
          e.message
      }
    );
  }
}

// =========================
// ODOO
// =========================
async function sincronizarOdoo(
  phone,
  mensaje
) {

  try {

    const uid =
      await getOdooUid();

    const models =
      xmlrpc.createSecureClient({

        url:
`${ODOO_URL.replace(/\/$/, "")}/xmlrpc/2/object`
      });

    models.methodCall(

      "execute_kw",

      [

        ODOO_DB,
        uid,
        ODOO_API_KEY,

        "crm.lead",
        "search_read",

        [[
          ["partner_name", "=", phone]
        ]],

        {
          fields: [
            "id",
            "description"
          ],

          limit: 1
        }
      ],

      async (err, leads) => {

        if (err) {

          return logger(
            "error",
            "ODOO_SEARCH_ERROR",
            {
              err:
                err.message
            }
          );
        }

        const etapa =
          detectarEtapa(
            mensaje
          );

        // =========================
        // UPDATE
        // =========================
        if (
          leads &&
          leads.length > 0
        ) {

          const lead =
            leads[0];

          const nuevoHistorial =
`${lead.description || ""}

━━━━━━━━━━
${new Date().toLocaleString()}

${mensaje}
`;

          return models.methodCall(

            "execute_kw",

            [

              ODOO_DB,
              uid,
              ODOO_API_KEY,

              "crm.lead",
              "write",

              [
                [lead.id],

                {
                  description:
                    nuevoHistorial
                }
              ]
            ],

            async (err) => {

              if (err) {

                return logger(
                  "error",
                  "ODOO_UPDATE_ERROR",
                  {
                    err:
                      err.message
                  }
                );
              }

              await moverLeadEtapa(
                models,
                uid,
                lead.id,
                etapa
              );
            }
          );
        }

        // =========================
        // CREATE
        // =========================
        const stageId =
          await obtenerStageId(
            models,
            uid,
            etapa
          );

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
`WhatsApp: ${phone}`,

              partner_name:
                phone,

              description:
                mensaje,

              type:
                "opportunity",

              stage_id:
                stageId
            }]]
          ],

          (err) => {

            if (err) {

              logger(
                "error",
                "ODOO_CREATE_ERROR",
                {
                  err:
                    err.message
                }
              );
            }
          }
        );
      }
    );

  } catch (e) {

    logger(
      "error",
      "ODOO_FATAL",
      {
        err:
          e.message
      }
    );
  }
}

// =========================
// ENVIAR WHATSAPP
// =========================
async function enviarMensaje(
  phone,
  message
) {

  try {

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

        message:
          String(message)
          .replace(/\*/g, "")
          .trim(),

        checkContact:
          false
      },

      timeout:
        15000
    });

  } catch (e) {

    logger(
      "error",
      "ZAPI_SEND_ERROR",
      {
        err:
          e.message
      }
    );
  }
}

// =========================
// OPENAI
// =========================
async function procesarMensaje(
  phone,
  textMessage
) {

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
    // REDIS THREAD
    // =========================
    if (
      !threadId &&
      redis
    ) {

      threadId =
        await redis.get(
          `thread:${phone}`
        );

      if (threadId) {

        threads.set(
          phone,
          threadId
        );
      }
    }

    // =========================
    // CREAR THREAD
    // =========================
    if (!threadId) {

      const thread =
        await axios.post(

          "https://api.openai.com/v1/threads",

          {},

          {
            headers,
            timeout: 15000
          }
        );

      threadId =
        thread.data.id;

      threads.set(
        phone,
        threadId
      );

      if (redis) {

        await redis.set(

          `thread:${phone}`,

          threadId
        );
      }
    }

    // =========================
    // USER MESSAGE
    // =========================
    await axios.post(

`https://api.openai.com/v1/threads/${threadId}/messages`,

      {

        role: "user",

        content:
          textMessage
      },

      {
        headers,
        timeout: 15000
      }
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

      {
        headers,
        timeout: 15000
      }
    );

    const runId =
      run.data.id;

    const startedAt =
      Date.now();

    let completed =
      false;

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
          setTimeout(
            r,
            1500
          )
      );

      const check =
        await axios.get(

`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,

        {
          headers,
          timeout: 15000
        }
      );

      const status =
        check.data.status;

      if (
        status ===
        "completed"
      ) {

        completed =
          true;

      } else if (

        [
          "failed",
          "expired",
          "cancelled"
        ].includes(status)

      ) {

        throw new Error(
          `RUN_${status}`
        );
      }
    }

    // =========================
    // LEER RESPUESTA
    // =========================
    const messages =
      await axios.get(

`https://api.openai.com/v1/threads/${threadId}/messages`,

      {
        headers,
        timeout: 15000
      }
    );

    const respuesta =
      messages.data.data[0]
      ?.content?.[0]
      ?.text?.value
      ?.trim();

    if (!respuesta) {

      return;
    }

    await enviarMensaje(
      phone,
      respuesta
    );

  } catch (e) {

    logger(
      "error",
      "OPENAI_ERROR",
      {
        phone,
        err:
          e.message
      }
    );
  }
}

// =========================
// WEBHOOK
// =========================
app.post(

  "/webhook",

  async (req, res) => {

    try {

      const body =
        req.body || {};

      const messageId =
        body.messageId || "";

      // =========================
      // DUPLICADOS
      // =========================
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

      const fromMe =
        body.fromMe === true ||
        body.fromMe === "true";

      const isGroup =
        body.isGroup === true ||
        body.isGroup === "true";

      const phone =
        String(
          body.phone || ""
        )
        .replace(/\D/g, "");

      const textMessage =
        String(

          body.text?.message ||
          ""
        ).trim();

      if (!phone) {

        return res.sendStatus(200);
      }

      if (!textMessage) {

        return res.sendStatus(200);
      }

      if (isGroup) {

        return res.sendStatus(200);
      }

      // =========================
      // TAKEOVER
      // =========================
      if (fromMe) {

        humanTakeover[phone] =
          Date.now();

        if (redis) {

          await redis.set(

            `ctx:${phone}`,

            JSON.stringify({
              humano: true
            }),

            "EX",
            60 * 30
          );
        }

        return res.sendStatus(200);
      }

      // =========================
      // CONTEXTO
      // =========================
      let ctx = null;

      if (redis) {

        const redisCtx =
          await redis.get(
            `ctx:${phone}`
          );

        if (redisCtx) {

          ctx =
            JSON.parse(
              redisCtx
            );
        }
      }

      // =========================
      // HUMAN ACTIVE
      // =========================
      if (

        ctx?.humano ||

        (
          humanTakeover[phone] &&

          (
            Date.now() -
            humanTakeover[phone]
          ) <

          1000 * 60 * 30
        )

      ) {

        return res.sendStatus(200);
      }

      // =========================
      // BUFFER
      // =========================
      if (!buffers[phone]) {

        buffers[phone] = {

          textos: [],
          timeout: null
        };
      }

      buffers[phone]
      .textos
      .push(textMessage);

      clearTimeout(
        buffers[phone]
        .timeout
      );

      buffers[phone]
      .timeout =
        setTimeout(

          async () => {

            try {

              const finalMessage =
                buffers[phone]
                .textos
                .join("\n");

              delete buffers[phone];

              logger(
                "info",
                "MESSAGE_RECEIVED",
                {
                  phone,
                  message:
                    finalMessage
                }
              );

              // =========================
              // ODOO
              // =========================
              sincronizarOdoo(
                phone,
                finalMessage
              );

              // =========================
              // BUSINESS
              // =========================
              const lower =
                finalMessage
                .toLowerCase();

              const esNegocio =

                /\b\d+\s?(real|reales|r\$|cup|usd|mlc)\b/i
                .test(lower)

                ||

                lower.includes(
                  "remesa"
                )

                ||

                lower.includes(
                  "enviar"
                )

                ||

                lower.includes(
                  "tasa"
                )

                ||

                lower.includes(
                  "pix"
                );

              if (!esNegocio) {

                return;
              }

              // =========================
              // OPENAI
              // =========================
              await procesarMensaje(

                phone,
                finalMessage
              );

            } catch (e) {

              logger(
                "error",
                "BUFFER_ERROR",
                {
                  err:
                    e.message
                }
              );
            }

          },

          1500
        );

      return res.sendStatus(200);

    } catch (e) {

      logger(
        "error",
        "WEBHOOK_ERROR",
        {
          err:
            e.message
        }
      );

      return res.sendStatus(200);
    }
  }
);

// =========================
// HEALTH
// =========================
app.get(

  "/",

  (req, res) => {

    res.send(
      "YordaBot Online"
    );
  }
);

// =========================
// START
// =========================
const PORT =
  process.env.PORT || 8080;

app.listen(

  PORT,

  "0.0.0.0",

  () => {

    console.log(
`✅ Servidor activo puerto ${PORT}`
    );
  }
);

// =========================
// ANTI CRASH
// =========================
process.on(

  "unhandledRejection",

  err => {

    logger(
      "error",
      "UNHANDLED_REJECTION",
      {
        err:
          err?.message
      }
    );
  }
);

process.on(

  "uncaughtException",

  err => {

    logger(
      "error",
      "UNCAUGHT_EXCEPTION",
      {
        err:
          err?.message
      }
    );
  }
);
