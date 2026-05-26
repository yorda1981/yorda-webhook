const axios = require("axios");

const redis =
  require("./redis");

const logger =
  require("../utils/logger");

const {
  OPENAI_API_KEY,
  OPENAI_ASSISTANT_ID
} = require("../config/env");

const {
  enviarMensaje
} = require("./zapi");

const threads =
  new Map();

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

    // REDIS THREAD
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

    // CREATE THREAD
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

    // USER MESSAGE
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

    // RUN
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

    // POLLING
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

    // READ RESPONSE
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
