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
// MEMORIA
// =========================
const mensajesProcesados = new Set();

const buffers = {};

const saludosEnviados = {};

// THREADS PERSISTENTES
const threads = {};

// NUEVO:
// CONTEXTO DE CONVERSACIÓN
const conversaAtiva = {};

let cachedUid = null;

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
// HORARIO BRASIL
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

// =========================
// ENVIAR MENSAJE
// =========================
async function enviarMensaje(phone, message) {

  await axios({
    method: "post",
    url:
`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
    headers: {
      "Client-Token": ZAPI_CLIENT_TOKEN,
      "Content-Type": "application/json"
    },
    data: {
      phone,
      message,
      checkContact: false
    }
  });
}

// =========================
// AUTH ODOO
// =========================
async function autenticarOdoo() {

  return new Promise((resolve, reject) => {

    if (cachedUid) {
      return resolve(cachedUid);
    }

    const common =
      xmlrpc.createSecureClient({
        url:
`${ODOO_URL}/xmlrpc/2/common`
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

        logger(
          "info",
          "ODOO_AUTH_SUCCESS",
          { uid }
        );

        resolve(uid);
      }
    );
  });
}

// =========================
// CREAR LEAD ODOO
// =========================
async function registrarEnOdoo({
  phone,
  mensaje
}) {

  try {

    const uid =
      await autenticarOdoo();

    const models =
      xmlrpc.createSecureClient({
        url:
`${ODOO_URL}/xmlrpc/2/object`
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
          name:
`WhatsApp ${phone}`,
          partner_name: phone,
          description: mensaje
        }]]
      ],
      (err, result) => {

        if (!err) {

          logger(
            "info",
            "ODOO_LEAD_CREATED",
            {
              id: result,
              phone
            }
          );
        }
      }
    );

  } catch (e) {

    logger(
      "error",
      "ODOO_ERROR",
      {
        message: e.message
      }
    );
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

    logger(
      "info",
      "BUSINESS_DETECTED",
      {
        phone,
        message: textMessage
      }
    );

    // =========================
    // REGISTRAR ODOO
    // =========================
    registrarEnOdoo({
      phone,
      mensaje: textMessage
    });

    // =========================
    // SALUDO ÚNICO
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
`${obtenerSaludo()}

`;

      saludosEnviados[phone] =
        ahora;
    }

    // =========================
    // THREAD PERSISTENTE
    // =========================
    let threadId =
      threads[phone];

    if (!threadId) {

      const thread =
        await axios.post(
          "https://api.openai.com/v1/threads",
          {},
          {
            headers: {
              Authorization:
`Bearer ${OPENAI_API_KEY}`,
              "Content-Type":
"application/json",
              "OpenAI-Beta":
"assistants=v2"
            }
          }
        );

      threadId =
        thread.data.id;

      threads[phone] =
        threadId;

      logger(
        "info",
        "THREAD_CREATED",
        {
          phone,
          threadId
        }
      );
    }

    // =========================
    // AGREGAR MENSAJE
    // =========================
    await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      {
        role: "user",
        content: textMessage
      },
      {
        headers: {
          Authorization:
`Bearer ${OPENAI_API_KEY}`,
          "Content-Type":
"application/json",
          "OpenAI-Beta":
"assistants=v2"
        }
      }
    );

    // =========================
    // EJECUTAR ASSISTANT
    // =========================
    const run =
      await axios.post(
        `https://api.openai.com/v1/threads/${threadId}/runs`,
        {
          assistant_id:
"asst_0iCMGSSNWcXP7H6Eo1yEM536"
        },
        {
          headers: {
            Authorization:
`Bearer ${OPENAI_API_KEY}`,
            "Content-Type":
"application/json",
            "OpenAI-Beta":
"assistants=v2"
          }
        }
      );

    const runId =
      run.data.id;

    // =========================
    // ESPERAR RESPUESTA
    // =========================
    let completed = false;

    while (!completed) {

      await new Promise(r =>
        setTimeout(r, 1500)
      );

      const check =
        await axios.get(
          `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
          {
            headers: {
              Authorization:
`Bearer ${OPENAI_API_KEY}`,
              "OpenAI-Beta":
"assistants=v2"
            }
          }
        );

      const status =
        check.data.status;

      if (
        status ===
        "completed"
      ) {

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

    // =========================
    // LEER RESPUESTA
    // =========================
    const messages =
      await axios.get(
        `https://api.openai.com/v1/threads/${threadId}/messages`,
        {
          headers: {
            Authorization:
`Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta":
"assistants=v2"
          }
        }
      );

    const respuestaIA =
      messages.data.data[0]
      ?.content?.[0]
      ?.text?.value
      ?.trim();

    if (!respuestaIA) {
      return;
    }

    const mensajeFinal =
`${saludo}${respuestaIA}`.trim();

    await enviarMensaje(
      phone,
      mensajeFinal
    );

    logger(
      "info",
      "MESSAGE_SENT",
      { phone }
    );

  } catch (e) {

    logger(
      "error",
      "PROCESS_MESSAGE_ERROR",
      {
        message: e.message,
        status:
e.response?.status,
        response:
e.response?.data
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
        mensajesProcesados.has(
          fingerprint
        )
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

      // =========================
      // ACTIVAR CONTEXTO
      // =========================
      if (esNegocio) {

        conversaAtiva[phone] = {
          ativa: true,
          ultimaInteracao:
            Date.now()
        };
      }

      const conversaExiste =
        conversaAtiva[phone] &&
        (
          Date.now() -
          conversaAtiva[phone]
            .ultimaInteracao
        ) < (1000 * 60 * 30);

      // =========================
      // IGNORAR SOLO SI
      // NO HAY CONTEXTO
      // =========================
      if (
        !esNegocio &&
        !conversaExiste
      ) {

        return res.sendStatus(200);
      }

      // =========================
      // ACTUALIZAR CONTEXTO
      // =========================
      if (
        conversaAtiva[phone]
      ) {

        conversaAtiva[phone]
          .ultimaInteracao =
            Date.now();
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

      logger(
        "error",
        "WEBHOOK_ERROR",
        {
          message: e.message
        }
      );

      return res.sendStatus(200);
    }
  }
);

// =========================
// HEALTHCHECK
// =========================
app.get("/", (req, res) => {

  res.send(
    "✅ YordaBot Online"
  );
});

// =========================
// START SERVER
// =========================
app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
`✅ Servidor activo en puerto ${PORT}`
    );
  }
);
