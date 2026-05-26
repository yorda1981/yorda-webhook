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
// DETECTAR PRODUCTO
// =====================
function detectarTipoOperacion(
  text
) {

  const lower =
    text.toLowerCase();

  // USD
  if (

    lower.includes("usd")

    ||

    lower.includes("dolar")

    ||

    lower.includes("dólar")

  ) {

    if (

      lower.includes("clasica")

      ||

      lower.includes("clásica")

    ) {

      return "usd_clasica";
    }

    if (

      lower.includes("prepago")

    ) {

      return "usd_prepago";
    }

    return "usd_clasica";
  }

  // RECARGA
  if (

    lower.includes("saldo")

    ||

    lower.includes("recarga")

  ) {

    return "saldo_cup";
  }

  // EFECTIVO
  if (

    lower.includes("efectivo")

    ||

    lower.includes("habana")

    ||

    lower.includes("havana")

  ) {

    return "efectivo_habana";
  }

  // DEFAULT
  return "brl_cup";
}

// =====================
// DETECTAR MUNICIPIO
// =====================
function detectarMunicipio(
  text
) {

  const municipios = [

    "habana vieja",
    "centro habana",
    "plaza",
    "cerro",
    "diez de octubre",

    "playa",
    "marianao",
    "boyeros",
    "san miguel",
    "habana del este",
    "guanabacoa",
    "arroyo naranjo",
    "cotorro",
    "la lisa"
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

  const headers = {

    Authorization:
`Bearer ${OPENAI_API_KEY}`,

    "Content-Type":
      "application/json",

    "OpenAI-Beta":
      "assistants=v2"
  };

  try {

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

        // =====================
        // BRL → CUP
        // =====================
        if (
          tipo ===
          "brl_cup"
        ) {

          contextoComercial =
`
OPERACIÓN CALCULADA

Cliente envía:
R$${resultado.valor}

Tasa aplicada:
${resultado.tasa}

Cliente recibe:
${resultado.cup} CUP
`;

          if (
            resultado.upsell
          ) {

            contextoComercial +=
`

OPORTUNIDAD UPSELL

Si agrega:
R$${resultado.upsell.falta}

Recibe:
${resultado.upsell.nuevoTotal} CUP
`;
          }
        }

        // =====================
        // USD
        // =====================
        if (

          tipo ===
          "usd_clasica"

          ||

          tipo ===
          "usd_prepago"

        ) {

          contextoComercial =
`
OPERACIÓN USD

Cliente desea cargar:
${resultado.usd} USD

Total:
R$${resultado.reales}

Tasa:
1 USD = ${resultado.tasa} BRL
`;
        }

        // =====================
        // RECARGA
        // =====================
        if (
          tipo ===
          "saldo_cup"
        ) {

          contextoComercial =
`
RECARGA DE SALDO

Cliente envía:
R$${resultado.reales}

Saldo recibido:
${resultado.cup} CUP

Vigencia:
${resultado.vigencia} días
`;
        }

        // =====================
        // EFECTIVO
        // =====================
        if (
          tipo ===
          "efectivo_habana"
        ) {

          contextoComercial =
`
EFECTIVO HABANA

Cliente envía:
R$${resultado.valor}

Cliente recibe:
${resultado.cup} CUP

Entrega:
R$${resultado.entrega}

Municipio:
${resultado.municipio || "No informado"}
`;
        }
      }
    }

    let threadId =
      threads.get(phone);

    // =====================
    // REDIS THREAD
    // =====================
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

    const startedAt =
      Date.now();

    let completed =
      false;

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

module.exports = {
  procesarMensaje
};
