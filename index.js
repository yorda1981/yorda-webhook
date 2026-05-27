const express = require("express");
const rateLimit = require("express-rate-limit");

require("dotenv").config();

const app = express();

app.use(express.json({ limit: "10mb" }));

app.set("trust proxy", 1);

app.disable("x-powered-by");

// =========================
// SERVICES
// =========================
const redis =
  require("./src/services/redis");

const {
  procesarMensaje
} = require("./src/services/openai");

const logger =
  require("./src/utils/logger");

const {
  detectarIntencion
} = require("./src/engines/intent-engine");

// =========================
// RATE LIMIT
// =========================
app.use(

  rateLimit({

    windowMs:
      60 * 1000,

    max: 120
  })
);

// =========================
// MEMORIA
// =========================
const mensajesProcesados =
  new Set();

const humanTakeover =
  {};

const buffers =
  {};

// =========================
// LIMPIAR DUPLICADOS
// =========================
setInterval(() => {

  mensajesProcesados.clear();

}, 1000 * 60 * 30);

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

      // =====================
      // DUPLICADOS
      // =====================
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

      // =====================
      // TAKEOVER
      // =====================
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

      // =====================
      // CONTEXTO
      // =====================
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

      // =====================
      // HUMAN ACTIVE
      // =====================
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

      // =====================
      // INTENT ENGINE V2
      // =====================
      const esNegocio =
        detectarIntencion(
          textMessage
        );

      if (!esNegocio) {

        logger(
          "info",
          "IGNORED_MESSAGE",
          {
            phone,
            message:
              textMessage
          }
        );

        return res.sendStatus(200);
      }

      // =====================
      // BUFFER
      // =====================
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

              // =====================
              // OPENAI
              // =====================
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
