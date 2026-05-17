// =========================
// IMPORTS
// =========================
const express = require("express");
const axios = require("axios");
const xmlrpc = require("xmlrpc");

// =========================
// REDIS SAFE LOAD
// =========================
let Redis = null;
let redis = null;

try {

  Redis = require("ioredis");

  if (process.env.REDIS_URL) {

    redis = new Redis(
      process.env.REDIS_URL
    );

    console.log(
      "✅ Redis conectado"
    );

  } else {

    console.log(
      "⚠️ REDIS_URL no configurado"
    );
  }

} catch (e) {

  console.log(
    "⚠️ ioredis no instalado — usando memoria RAM"
  );
}

// =========================
// RATE LIMIT SAFE LOAD
// =========================
let rateLimit = null;

try {

  rateLimit =
    require("express-rate-limit");

} catch {

  console.log(
    "⚠️ express-rate-limit no instalado"
  );
}

// =========================
// APP
// =========================
const app = express();

app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(
  express.json({
    limit: "10mb"
  })
);

// =========================
// RATE LIMIT
// =========================
if (rateLimit) {

  app.use(rateLimit({

    windowMs:
      60 * 1000,

    max: 300,

    standardHeaders: true,
    legacyHeaders: false

  }));
}

const PORT =
  process.env.PORT || 8080;

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

    console.log(
      `❌ ENV faltante: ${key}`
    );

    process.exit(1);
  }
}

// =========================
// MEMORIA
// =========================
const flood = {};
const buffers = {};
const cacheTasas = {};
const mensajesProcesados =
  new Set();

const ramThreads = {};
const ramContext = {};

let cachedUid = null;

// =========================
// LOGGER
// =========================
function logger(
  level,
  event,
  meta = {}
) {

  console.log(
    JSON.stringify({
      ts:
        new Date()
        .toISOString(),
      level,
      event,
      ...meta
    })
  );
}

// =========================
// REDIS HELPERS
// =========================
async function getThread(phone) {

  if (!redis) {
    return ramThreads[phone];
  }

  return await redis.get(
    `thread:${phone}`
  );
}

async function setThread(
  phone,
  threadId
) {

  if (!redis) {

    ramThreads[phone] =
      threadId;

    return;
  }

  await redis.set(
    `thread:${phone}`,
    threadId,
    "EX",
    86400
  );
}

async function getContext(
  phone
) {

  if (!redis) {

    return ramContext[phone];
  }

  const data =
    await redis.get(
      `ctx:${phone}`
    );

  return data
    ? JSON.parse(data)
    : null;
}

async function setContext(
  phone,
  data
) {

  if (!redis) {

    ramContext[phone] =
      data;

    return;
  }

  await redis.set(
    `ctx:${phone}`,
    JSON.stringify(data),
    "EX",
    3600
  );
}

// =========================
// LIMPIEZA MEMORIA
// =========================
setInterval(() => {

  mensajesProcesados.clear();

  for (const phone in buffers) {

    if (
      !buffers[phone]?.timer
    ) {

      delete buffers[phone];
    }
  }

}, 1000 * 60 * 30);

// =========================
// HORA BRASIL
// =========================
function obtenerHoraBrasil() {

  return Number(

    new Intl.DateTimeFormat(
      "pt-BR",
      {
        timeZone:
          "America/Sao_Paulo",
        hour: "numeric",
        hour12: false
      }

    ).format(new Date())
  );
}

function obtenerSaludo() {

  const hora =
    obtenerHoraBrasil();

  if (
    hora >= 6 &&
    hora < 12
  ) {

    return "Bom dia 👋";
  }

  if (
    hora >= 12 &&
    hora < 18
  ) {

    return "Boa tarde 👋";
  }

  return "Boa noite 👋";
}

// =========================
// ENVIAR MENSAJE
// =========================
async function enviarMensaje(
  phone,
  message
) {

  await axios.post(

`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,

    {
      phone,
      message,
      checkContact: false
    },

    {
      headers: {
        "Client-Token":
          ZAPI_CLIENT_TOKEN
      },

      timeout: 15000
    }
  );
}

// =========================
// AUTH ODOO
// =========================
async function autenticarOdoo() {

  if (cachedUid) {
    return cachedUid;
  }

  return new Promise((
    resolve,
    reject
  ) => {

    const urlLimpia =
      String(ODOO_URL)
      .replace(/\/$/, "");

    const common =
      xmlrpc.createSecureClient({

        url:
`${urlLimpia}/xmlrpc/2/common`

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

        if (
          err ||
          !uid
        ) {

          return reject(
            err ||
            new Error(
              "UID inválido"
            )
          );
        }

        cachedUid = uid;

        resolve(uid);
      }
    );
  });
}

// =========================
// CONSULTAR TASAS
// =========================
async function consultarTasasOdoo(
  tipoMoneda = "CUP"
) {

  const cacheKey =
    `tasas:${tipoMoneda}`;

  if (

    cacheTasas[cacheKey] &&

    (
      Date.now() -
      cacheTasas[cacheKey].time
    ) < 30000

  ) {

    return cacheTasas[
      cacheKey
    ].data;
  }

  return new Promise(
    async (
      resolve,
      reject
    ) => {

      try {

        const uid =
          await autenticarOdoo();

        const urlLimpia =
          String(ODOO_URL)
          .replace(/\/$/, "");

        const models =
          xmlrpc
          .createSecureClient({

            url:
`${urlLimpia}/xmlrpc/2/object`

          });

        let refs = [];

        if (
          tipoMoneda ===
          "CUP"
        ) {

          refs = [

            "TASA_CUP_BAJA",
            "TASA_CUP_MEDIA",
            "TASA_CUP_ALTA"

          ];

        } else {

          refs = [
            `TASA_${tipoMoneda}`
          ];
        }

        models.methodCall(

          "execute_kw",

          [
            ODOO_DB,
            uid,
            ODOO_API_KEY,

            "product.product",

            "search_read",

            [[[
              "default_code",
              "in",
              refs
            ]]],

            {
              fields: [
                "default_code",
                "list_price"
              ]
            }
          ],

          (
            err,
            products
          ) => {

            if (err) {
              return reject(err);
            }

            const tasas = {};

            products.forEach(p => {

              tasas[
                p.default_code
              ] =
                p.list_price;
            });

            cacheTasas[
              cacheKey
            ] = {

              data: tasas,
              time: Date.now()

            };

            resolve(tasas);
          }
        );

      } catch (e) {

        reject(e);
      }
    }
  );
}

// =========================
// REGISTRAR ODOO
// =========================
async function registrarEnOdoo({
  phone,
  mensaje
}) {

  try {

    const uid =
      await autenticarOdoo();

    const urlLimpia =
      String(ODOO_URL)
      .replace(/\/$/, "");

    const models =
      xmlrpc
      .createSecureClient({

        url:
`${urlLimpia}/xmlrpc/2/object`

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

          partner_name:
            phone,

          description:
            mensaje,

          type:
            "opportunity"

        }]]
      ],

      (
        err,
        res
      ) => {

        if (!err) {

          logger(
            "info",
            "ODOO_LEAD_CREATED",
            {
              id: res,
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
        err: e.message
      }
    );
  }
}

// =========================
// RESPUESTA RÁPIDA
// =========================
function respuestaRapida(
  texto
) {

  const lower =
    texto.toLowerCase();

  if (
    lower === "hola" ||
    lower === "oi"
  ) {

    return
`${obtenerSaludo()}

Hola 😊
¿Cómo puedo ayudarte?`;
  }

  if (

    lower === "pix" ||

    lower.includes(
      "quiero pagar"
    ) ||

    lower.includes(
      "manda pix"
    )

  ) {

    return
`PIX:

8becaaf5-f296-4cbc-a115-46e3d23b042a

Titular:
Yordanys Rafael Sosa Reyes`;
  }

  return null;
}

// =========================
// ASSISTANT CORE
// =========================
async function procesarMensaje(
  phone,
  textMessage
) {

  try {

    const headers = {

      Authorization:
`Bearer ${OPENAI_API_KEY}`,

      "Content-Type":
        "application/json",

      "OpenAI-Beta":
        "assistants=v2"
    };

    let threadId =
      await getThread(phone);

    if (!threadId) {

      const thread =
        await axios.post(

          "https://api.openai.com/v1/threads",

          {},

          { headers }

        );

      threadId =
        thread.data.id;

      await setThread(
        phone,
        threadId
      );
    }

    await axios.post(

`https://api.openai.com/v1/threads/${threadId}/messages`,

      {
        role: "user",
        content: textMessage
      },

      { headers }
    );

    let run =
      await axios.post(

`https://api.openai.com/v1/threads/${threadId}/runs`,

        {
          assistant_id:
"asst_0iCMGSSNWcXP7H6Eo1yEM536"
        },

        { headers }
      );

    const startedAt =
      Date.now();

    let completed =
      false;

    while (!completed) {

      if (

        Date.now() -
        startedAt >

        45000

      ) {

        throw new Error(
          "Run timeout"
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

`https://api.openai.com/v1/threads/${threadId}/runs/${run.data.id}`,

          { headers }
        );

      if (
        check.data.status ===
        "completed"
      ) {

        completed = true;

      } else if (

        check.data.status ===
        "requires_action"

      ) {

        const toolCalls =
          check.data
          .required_action
          .submit_tool_outputs
          .tool_calls;

        const outputs = [];

        for (const tc of toolCalls) {

          const args =
            JSON.parse(
              tc.function
              .arguments
            );

          const res =
            await consultarTasasOdoo(
              args.tipo_envio
            );

          outputs.push({

            tool_call_id:
              tc.id,

            output:
              JSON.stringify(
                res
              )
          });
        }

        await axios.post(

`https://api.openai.com/v1/threads/${threadId}/runs/${run.data.id}/submit_tool_outputs`,

          {
            tool_outputs:
              outputs
          },

          { headers }
        );

      } else if (

        [
          "failed",
          "expired"
        ].includes(
          check.data.status
        )

      ) {

        throw new Error(
          "Run failed"
        );
      }
    }

    const messages =
      await axios.get(

`https://api.openai.com/v1/threads/${threadId}/messages`,

        { headers }
      );

    const respuesta =
      messages.data.data[0]
      ?.content?.[0]
      ?.text?.value;

    if (respuesta) {

      await enviarMensaje(
        phone,
        respuesta
      );
    }

  } catch (e) {

    logger(
      "error",
      "AGENT_ERROR",
      {
        phone,
        err: e.message
      }
    );

    await enviarMensaje(

      phone,

`Lo siento 🙏

Estoy teniendo una demora momentánea.`

    );
  }
}

// =========================
// WEBHOOK
// =========================
app.post(
  "/webhook",
  async (
    req,
    res
  ) => {

    try {

      const body =
        req.body;

      if (

        !body.phone ||

        body.fromMe ||

        body.isGroup ||

        !body.text?.message

      ) {

        return res.sendStatus(
          200
        );
      }

      const phone =
        body.phone
        .replace(/\D/g, "");

      const textMessage =
        body.text.message
        .trim();

      const lower =
        textMessage
        .toLowerCase();

      // =========================
      // ANTI DUPLICADO
      // =========================
      const fingerprint =
`${phone}:${lower}`;

      if (

        mensajesProcesados
        .has(fingerprint)

      ) {

        return res.sendStatus(
          200
        );
      }

      mensajesProcesados
      .add(fingerprint);

      setTimeout(() => {

        mensajesProcesados
        .delete(fingerprint);

      }, 30000);

      // =========================
      // FLOOD
      // =========================
      const now =
        Date.now();

      if (

        flood[phone] &&

        (
          now -
          flood[phone]
        ) < 1500

      ) {

        return res.sendStatus(
          200
        );
      }

      flood[phone] =
        now;

      // =========================
      // CONTEXTO
      // =========================
      const contexto =
        await getContext(
          phone
        ) || {

          ativa: false,

          ultimaInteracao: 0,

          leadRegistrado: false,

          humano: false
        };

      // =========================
      // MODO HUMANO
      // =========================
      if (
        contexto.humano
      ) {

        return res.sendStatus(
          200
        );
      }

      // =========================
      // RESPUESTA RÁPIDA
      // =========================
      const fastReply =
        respuestaRapida(
          textMessage
        );

      if (fastReply) {

        await enviarMensaje(
          phone,
          fastReply
        );

        return res.sendStatus(
          200
        );
      }

      // =========================
      // NEGOCIO
      // =========================
      const gatillos = [

        "remesa",
        "envio",
        "enviar",
        "transferencia",
        "mandar",

        "cup",
        "mlc",
        "usd",

        "pix",

        "real",
        "reais",
        "reales",
        "rs",
        "r$"

      ];

      const palabras =
        lower
        .replace(
          /[^\w\s$]/g,
          ""
        )
        .split(/\s+/);

      const esNegocio =

        gatillos.some(g =>
          palabras.includes(g)
        ) ||

        /\d+/.test(lower);

      const conversaExiste =

        (
          now -
          contexto
          .ultimaInteracao
        ) < 1800000;

      if (

        !esNegocio &&

        !conversaExiste

      ) {

        return res.sendStatus(
          200
        );
      }

      // =========================
      // ACTUALIZAR CONTEXTO
      // =========================
      contexto.ativa = true;

      contexto.ultimaInteracao =
        now;

      await setContext(
        phone,
        contexto
      );

      // =========================
      // LEAD ODOO
      // =========================
      if (

        !contexto
        .leadRegistrado

      ) {

        contexto
        .leadRegistrado =
          true;

        await setContext(
          phone,
          contexto
        );

        registrarEnOdoo({

          phone,

          mensaje:
            textMessage

        });
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
        buffers[phone]
        .timer
      );

      buffers[phone]
      .timer =

        setTimeout(
          async () => {

            const fullText =

              buffers[phone]
              .texts
              .join(" ");

            delete buffers[phone];

            await procesarMensaje(
              phone,
              fullText
            );

          },
          2000
        );

      res.sendStatus(200);

    } catch (e) {

      logger(
        "error",
        "WEBHOOK_ERROR",
        {
          err: e.message
        }
      );

      res.sendStatus(200);
    }
  }
);

// =========================
// HEALTHCHECK
// =========================
app.get(
  "/",
  async (
    req,
    res
  ) => {

    try {

      if (redis) {
        await redis.ping();
      }

      res.json({

        status:
          "online",

        redis:
          !!redis,

        uptime:
          process.uptime()

      });

    } catch {

      res.status(500)
      .json({

        status:
          "error"

      });
    }
  }
);

// =========================
// START
// =========================
app.listen(

  PORT,

  "0.0.0.0",

  () =>

    logger(
      "info",
      `SAAS_ACTIVE_PORT_${PORT}`
    )
);
