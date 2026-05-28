```js
const axios = require("axios");

const redis =
  require("./redis");

const logger =
  require("../utils/logger");

const {
  calcularOperacion
} = require("../engines/pricing-engine");

const {
  guardarCliente,
  obtenerCliente
} = require("./customer-memory");

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
// EXTRAER VALOR
// =====================
function extraerValor(text) {

  const match =
    text.match(
      /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+)/
    );

  if (!match) {
    return null;
  }

  const valor =
    match[1]
      .replace(/\./g, "")
      .replace(",", ".");

  return Number(valor);
}

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
// VALIDAR RESPUESTA IA
// =====================
function validarRespuestaIA(
  respuesta,
  resultado
) {

  if (!respuesta) {
    return false;
  }

  // Validar total esperado
  if (

    !respuesta.includes(
      String(resultado.cup)
    )

  ) {

    return false;
  }

  return true;
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

    ```js id="xy2efm"
const headers = {

  Authorization: `Bearer ${OPENAI_API_KEY}`,

  "Content-Type":
    "application/json",

  "OpenAI-Beta":
    "assistants=v2"
};
```


    // =====================
    // VARIABLES
    // =====================
    let contextoComercial =
      "";

    let resultadoOperacion =
      null;

    // =====================
    // DETECTAR VALOR
    // =====================
    const valorOperacion =
      extraerValor(
        textMessage
      );

    const tipoOperacion =
      detectarTipoOperacion(
        textMessage
      );

    // =====================
    // CALCULAR
    // =====================
    if (

      valorOperacion &&
      valorOperacion > 0

    ) {

      const municipio =
        detectarMunicipio(
          textMessage
        );

      resultadoOperacion =
        calcularOperacion({

          tipo:
            tipoOperacion,

          valor:
            valorOperacion,

          municipio
        });

      if (resultadoOperacion) {

        // =====================
        // GUARDAR CLIENTE
        // =====================
        guardarCliente({

          phone,

          monto:
            valorOperacion,

          tipo:
            tipoOperacion
        });

        contextoComercial =
`
RESULTADO OFICIAL CALCULADO POR BACKEND

Cliente envía:
R$${resultadoOperacion.valor}

Tasa actual:
${resultadoOperacion.tasa}

Cliente recibe:
${resultadoOperacion.cup} CUP

IMPORTANTE:
- Los números fueron calculados por el backend
- Nunca recalcules
- Nunca alteres tasas
- Nunca inventes valores
- Solo redacta bonito
`;

        // =====================
        // UPSELL
        // =====================
        if (
          resultadoOperacion.upsell
        ) {

          contextoComercial +=
`

UPSELL DISPONIBLE

Si agrega:
R$${resultadoOperacion.upsell.falta}

Recibe:
${resultadoOperacion.upsell.nuevoTotal} CUP
`;
        }
      }
    }

    // =====================
    // MEMORIA CLIENTE
    // =====================
    const cliente =
      obtenerCliente(
        phone
      );

    if (cliente) {

      contextoComercial +=
`

CONTEXTO CLIENTE

Total operaciones:
${cliente.totalOperaciones}

Último monto:
R$${cliente.ultimoMonto}

Total enviado:
R$${cliente.totalEnviado}
`;

      // =====================
      // VIP
      // =====================
      if (
        cliente.totalEnviado >=
        5000
      ) {

        contextoComercial +=
`

CLIENTE VIP
Dar atención premium.
`;
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

    // =====================
    // VALIDAR IA
    // =====================
    if (

      resultadoOperacion &&
      !validarRespuestaIA(
        respuesta,
        resultadoOperacion
      )

    ) {

      logger(
        "error",
        "IA_INVALID_RESPONSE",
        {
          phone
        }
      );

      return await enviarMensaje(

        phone,

        `⚠️ Hubo un problema procesando el cálculo. Por favor intente nuevamente.`
      );
    }

    // =====================
    // SEND
    // =====================
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
```
