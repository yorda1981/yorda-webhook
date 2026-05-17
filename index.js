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
const HORA_APERTURA = 6;
const HORA_CIERRE = 22;

// =========================
// MEMORIA
// =========================
const mensajesProcesados = new Set();
const buffers = {};
const saludosEnviados = {};

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
// HORARIO
// =========================
function obtenerSaludo() {

  const ahora = new Date();

  const horaBrasil = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "numeric",
    hour12: false
  }).format(ahora);

  const hora = Number(horaBrasil);

  if (hora >= 6 && hora < 12) {
    return "Bom dia 👋";
  }

  if (hora >= 12 && hora < 18) {
    return "Boa tarde 👋";
  }

  return "Boa noite 👋";
}

function horarioAbierto() {

  const ahora = new Date();

  const horaBrasil = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "numeric",
    hour12: false
  }).format(ahora);

  const hora = Number(horaBrasil);

  return hora >= HORA_APERTURA &&
         hora < HORA_CIERRE;
}

// =========================
// ODOO
// =========================
function registrarEnOdoo(datos) {

  try {

    const urlLimpia =
      String(ODOO_URL || "").replace(/\/$/, "");

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

            if (Array.isArray(leads) && leads.length > 0) {

              logger("info", "ODOO_LEAD_EXISTS", {
                phone: datos.phone,
                leadId: leads[0]
              });

              return;
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
      }
    );

  } catch (e) {

    logger("error", "ODOO_FATAL", {
      err: e.message
    });
  }
}

// =========================
// ENVIAR MENSAJE
// =========================
async function enviarMensaje(phone, message) {

  await axios({
    method: "post",
    url: `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
    headers: {
      "Client-Token": ZAPI_CLIENT_TOKEN,
      "Content-Type": "application/json"
    },
    data: {
      phone,
      message
    },
    timeout: 15000
  });
}

// =========================
// PROCESAMIENTO
// =========================
async function procesarMensaje(phone, textMessage) {

  try {

    logger("info", "BUSINESS_DETECTED", {
      phone,
      message: textMessage
    });

    // =========================
    // HORARIO
    // =========================
    if (!horarioAbierto()) {

      const fueraHorario =
`${obtenerSaludo()}

Agora estamos fora do horário de atendimento 👌

⏰ Funcionamos das 06:00 às 22:00.`;

      await enviarMensaje(phone, fueraHorario);

      logger("warn", "OUTSIDE_BUSINESS_HOURS", {
        phone
      });

      return;
    }

    // =========================
    // PIX DIRECTO
    // =========================
    const pixTriggers = [
      "pix",
      "llave pix",
      "clave pix",
      "manda pix",
      "enviar pix",
      "quiero pagar",
      "pix para pagar",
      "pagar",
      "pago"
    ];

    const quierePix =
      pixTriggers.some(g =>
        textMessage.toLowerCase().includes(g)
      );

    if (quierePix) {

      // SOLO CÓDIGO PIX
      await enviarMensaje(
        phone,
`8becaaf5-f296-4cbc-a115-46e3d23b042a`
      );

      // PAUSA
      await new Promise(resolve =>
        setTimeout(resolve, 1500)
      );

      // DATOS APARTE
      await enviarMensaje(
        phone,
`Titular: YORDANYS RAFAEL SOSA REYES

Banco: Nubank (260)`
      );

      logger("info", "PIX_SENT", {
        phone
      });

      return;
    }

    // =========================
    // ODOO
    // =========================
    registrarEnOdoo({
      phone,
      mensaje: textMessage
    });

    // =========================
    // SALUDO
    // =========================
    let saludo = "";

    const ahora = Date.now();

    if (
      !saludosEnviados[phone] ||
      (ahora - saludosEnviados[phone]) > (1000 * 60 * 60 * 3)
    ) {

      saludo = `${obtenerSaludo()}\n\n`;

      saludosEnviados[phone] = ahora;
    }

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

              Reglas:
              - Responde corto.
              - Máximo 2 líneas.
              - Sonido humano.
              - No markdown.
              - Idioma del cliente.
              - No repetir saludos.
              - No inventar tasas.
              - No hablar de tasas.`
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

    const mensajeFinal =
      `${saludo}${respuestaIA}`.trim();

    // =========================
    // ENVIAR
    // =========================
    await enviarMensaje(
      phone,
      mensajeFinal
    );

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

    const textMessage =
      String(body.text?.message || "").trim();

    const fromMe =
      body.fromMe === true ||
      body.fromMe === "true";

    const isGroup =
      body.isGroup === true ||
      body.isGroup === "true";

    if (!phoneRaw || fromMe || isGroup || !textMessage) {
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

      // Remesas
      "remesa",
      "envio",
      "enviar",
      "transferencia",
      "mandar",
      "dinero",
      "giro",
      "cambio",

      // Monedas
      "cup",
      "usd",
      "mlc",
      "brl",
      "reales",
      "dolar",
      "dólar",

      // PIX
      "pix",
      "pagar",
      "pago",
      "llave pix",

      // Recargas
      "recarga",
      "saldo",
      "etecsa",
      "nauta",

      // Saludos
      "hola",
      "buenas",
      "buen dia",
      "buen día",
      "bom dia",
      "boa tarde",
      "boa noite",
      "oi",
      "ola",
      "olá"

    ];

    const esNegocio =
      gatillos.some(g =>
        textMessage.toLowerCase().includes(g)
      );

    if (!esNegocio) {
      return res.sendStatus(200);
    }

    // =========================
    // BUFFER
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
      message: e.message
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
// START
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
// ANTI CRASH
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
