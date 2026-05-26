const axios = require("axios");

const redis =
  require("./redis");

const logger =
  require("../utils/logger");

const {
  calcularOperacion
} = require("../engines/pricing-engine");

const {
  OPENAI_API_KEY,
  OPENAI_ASSISTANT_ID
} = require("../config/env");

const {
  enviarMensaje
} = require("./zapi");

// =====================
// THREADS
// =====================
const threads =
  new Map();

// =====================
// LOCKS
// =====================
const usuariosProcesando =
  new Set();

// =====================
// DETECTAR TIPO
// =====================
function detectarTipoOperacion(
  text
) {

  const lower =
    text.toLowerCase();

  if (

    lower.includes("usd")

    ||

    lower.includes("dolar")

    ||

    lower.includes("dólar")

  ) {

    if (

      lower.includes("prepago")

    ) {

      return "usd_prepago";
    }

    return "usd_clasica";
  }

  if (

    lower.includes("saldo")

    ||

    lower.includes("recarga")

  ) {

    return "saldo_cup";
  }

  if (

    lower.includes("habana")

    ||

    lower.includes("efectivo")

  ) {

    return "efectivo_habana";
  }

  return "brl_cup";
}

// =====================
// MUNICIPIO
// =====================
function detectarMunicipio(
  text
) {

  const municipios = [

    "habana vieja",
    "centro habana",
    "plaza",
    "cerro",
    "boyeros",
    "guanabacoa"
  ];

  const lower =
    text.toLowerCase();

  return municipios.find(
    m =>
      lower.includes(m)
  ) || null;
}

// =====================
// PROCESAR MENSAJE
// =====================
async function procesarMensaje(
  phone,
  textMessage
) {

  // =====================
  // LOCK
  // =====================
  if (

    usuariosProcesando.has(
      phone
    )

  ) {

    logger(
      "info",
      "USER_BUSY",
      { phone }
    );

    return;
  }

  usuariosProcesando.add(
    phone
  );

  try {

    const headers = {

      Authorization:
`Bearer ${OPENAI_API_KEY}`,

      "Content-Type":
        "application/json",

      "OpenAI-Beta":
        "assistants=v2"
    };

    // =====================
    // DETECTAR VALOR
    // =====================
    const regexValor =
      textMessage.match(/\d+/);

    let contextoComercial =
      "";

    if (regexValor) {

      const valor =
        Number(
          regexValor[0]
        );

      const tipo =
        detectarTipoOperacion(
          textMessage
        );

      const municipio =
        detectarMunicipio(
          textMessage
        );

      const resultado =
        calcularOperacion({

          tipo,
          valor,
          municipio
        });

      if (resultado) {

        if (
          tipo ===
          "brl_cup"
        ) {

          contextoComercial =
`
OPERACIÓN CALCULADA

Cliente envía:
R$${resultado.valor}

Tasa:
${resultado.tasa}

Cliente recibe:
${resultado.cup} CUP
`;

          if (
            resultado.upsell
          ) {

            contextoComercial +=
`

UPSELL DISPONIBLE

Si agrega:
R$${resultado.upsell.falta}

Recibe:
${resultado.upsell.nuevoTotal} CUP
`;
          }
        }
      }
    }

    // =====================
    // THREAD
    // =====================
    let threadId =
      threads.get(phone);

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

    // =====================
    // CREATE THREAD
    // =====================
    if (!threadId) {

      logger(
        "info",
        "NEW_THREAD",
        { phone }
      );

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

    // =====================
    // USER MESSAGE
    // =====================
    await axios.post(

`https://api.openai.com/v1/threads/${threadId}/messages`,

      {

        role: "user",

        content:
`${contextoComercial}

MENSAJE CLIENTE:
${textMessage}`
      },

      {
        headers,
        timeout: 15000
      }
    );

    logger(
      "info",
      "OPENAI_MESSAGE_SENT",
      { phone }
    );

    // =====================
    // RUN
    // =====================
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

    logger(
      "info",
      "RUN_CREATED",
      {
        phone,
        runId
      }
    );

    let completed =
      false;

    const startedAt =
      Date.now();

    // =====================
    // POLLING
    // =====================
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

      logger(
        "info",
        "RUN_STATUS",
        {
          phone,
          status
        }
      );

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

    // =====================
    // READ RESPONSE
    // =====================
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

      logger(
        "error",
        "EMPTY_RESPONSE",
        { phone }
      );

      return;
    }

    logger(
      "info",
      "OPENAI_RESPONSE",
      {
        phone
      }
    );

    await enviarMensaje(
      phone,
      respuesta
    );

    logger(
      "info",
      "MESSAGE_SENT",
      { phone }
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

  } finally {

    usuariosProcesando.delete(
      phone
    );
  }
}

module.exports = {
  procesarMensaje
};
