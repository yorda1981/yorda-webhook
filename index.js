const express = require("express");
const axios = require("axios");
const xmlrpc = require("xmlrpc");

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 8080;

// =========================
// ENV
// =========================
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

let cachedUid = null;

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
function obtenerHoraBrasil() {

  return Number(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "numeric",
      hour12: false
    }).format(new Date())
  );
}

function obtenerSaludo() {

  const hora = obtenerHoraBrasil();

  if (hora >= 6 && hora < 12) {
    return "Bom dia 👋";
  }

  if (hora >= 12 && hora < 18) {
    return "Boa tarde 👋";
  }

  return "Boa noite 👋";
}

function horarioAbierto() {

  const hora = obtenerHoraBrasil();

  return (
    hora >= HORA_APERTURA &&
    hora < HORA_CIERRE
  );
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
      message,
      checkContact: false
    },
    timeout: 15000
  });
}

// =========================
// AUTH ODOO
// =========================
async function autenticarOdoo() {

  return new Promise((resolve, reject) => {

    try {

      if (cachedUid) {
        return resolve(cachedUid);
      }

      const urlLimpia =
        String(ODOO_URL || "")
        .replace(/\/$/, "");

      const common =
        xmlrpc.createSecureClient({
          url: `${urlLimpia}/xmlrpc/2/common`
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

          cachedUid = uid;

          resolve(uid);
        }
      );

    } catch (e) {

      reject(e);
    }
  });
}

// =========================
// REGISTRAR ODOO
// =========================
async function registrarEnOdoo(datos) {

  try {

    const uid =
      await autenticarOdoo();

    const urlLimpia =
      String(ODOO_URL || "")
      .replace(/\/$/, "");

    const models =
      xmlrpc.createSecureClient({
        url: `${urlLimpia}/xmlrpc/2/object`
      });

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

        if (!err) {

          logger("info", "ODOO_LEAD_CREATED", {
            id: res,
            phone: datos.phone
          });
        }
      }
    );

  } catch (e) {

    logger("error", "ODOO_FATAL", {
      err: e.message
    });
  }
}

// =========================
// PROCESAR MENSAJE
// =========================
async function procesarMensaje(
  phone,
  textMessage
) {

  try {

    logger("info", "BUSINESS_DETECTED", {
      phone,
      message: textMessage
    });

    // =========================
    // HORARIO
    // =========================
    if (!horarioAbierto()) {

      await enviarMensaje(
        phone,
`${obtenerSaludo()}

Agora estamos fora do horário 👌

⏰ Atendimento:
06:00 às 22:00`
      );

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
      (
        ahora -
        saludosEnviados[phone]
      ) > (1000 * 60 * 60 * 3)
    ) {

      saludo =
        `${obtenerSaludo()}\n\n`;

      saludosEnviados[phone] =
        ahora;
    }

    // =========================
    // OPENAI ASSISTANT
    // =========================

    // 1. Crear thread
    const thread = await axios.post(
      "https://api.openai.com/v1/threads",
      {},
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2"
        }
      }
    );

    const threadId = thread.data.id;

    // 2. Agregar mensaje
    await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      {
        role: "user",
        content: textMessage
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2"
        }
      }
    );

    // 3. Ejecutar assistant
    const run = await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      {
        assistant_id:
          "asst_0iCMGSSNWcXP7H6Eo1yEM536"
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2"
        }
      }
    );

    const runId = run.data.id;

    // 4. Esperar respuesta
    let completed = false;

    while (!completed) {

      await new Promise(r =>
        setTimeout(r, 1500)
      );

      const check = await axios.get(
        `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "assistants=v2"
          }
        }
      );

      const status = check.data.status;

      if (status === "completed") {
        completed = true;
      }

      if (
        status === "failed" ||
        status === "cancelled" ||
        status === "expired"
      ) {

        throw new Error(
          `Assistant failed: ${status}`
        );
      }
    }

    // 5. Leer mensajes
    const messages = await axios.get(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2"
        }
      }
    );

    const respuestaIA =
      messages.data.data[0]
      ?.content?.[0]
      ?.text?.value
      ?.trim();

    if (!respuestaIA) {

      logger("warn", "EMPTY_AI_RESPONSE", {
        phone
      });

      return;
    }

    const mensajeFinal =
      `${saludo}${respuestaIA}`
      .trim();

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

    if (
      !phoneRaw ||
      fromMe ||
      isGroup ||
      !messageId ||
      !textMessage
    ) {

      return res.sendStatus(200);
    }

    const phone =
      String(phoneRaw)
      .replace(/\D/g, "");

    // =========================
    // ANTI DUPLICADO
    // =========================
    const fingerprint =
      `${phone}:${textMessage
        .toLowerCase()
        .trim()}`;

    if (
      mensajesProcesados
      .has(fingerprint)
    ) {

      return res.sendStatus(200);
    }

    mensajesProcesados.add(
      fingerprint
    );

    setTimeout(() => {

      mensajesProcesados.delete(
        fingerprint
      );

    }, 1000 * 30);

    // =========================
    // GATILLOS
    // =========================
    const gatillos = [

      "remesa",
      "envio",
      "enviar",
      "transferencia",
      "mandar",
      "dinero",
      "giro",
      "cambio",

      "cup",
      "usd",
      "mlc",
      "brl",
      "reales",

      "pix",
      "pagar",
      "pago",

      "recarga",
      "saldo",
      "etecsa",

      "hola",
      "buenas",
      "bom dia",
      "boa tarde",
      "boa noite",
      "oi"
    ];

    const esNegocio =
      gatillos.some(g =>
        textMessage
        .toLowerCase()
        .includes(g)
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

    buffers[phone]
      .texts
      .push(textMessage);

    clearTimeout(
      buffers[phone].timer
    );

    buffers[phone].timer =
      setTimeout(async () => {

        try {

          const fullText =
            buffers[phone]
            .texts
            .join(" ");

          delete buffers[phone];

          await procesarMensaje(
            phone,
            fullText
          );

        } catch (e) {

          logger(
            "error",
            "BUFFER_PROCESS_ERROR",
            {
              phone,
              err: e.message
            }
          );
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

  res.send(
    "✅ YordaBot Railway Online"
  );
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
