const axios = require("axios");

const {
  ZAPI_INSTANCE,
  ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN
} = require("../config/env");

const logger =
  require("../utils/logger");

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
        err: e.message
      }
    );
  }
}

module.exports = {
  enviarMensaje
};
