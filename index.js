```js
async function enviarMensaje(
  phone,
  texto
) {

  try {

    console.log("========== ZAPI CONFIG ==========");

    console.log(
      "INSTANCE:",
      ZAPI_INSTANCE
    );

    console.log(
      "TOKEN:",
      ZAPI_TOKEN
    );

    console.log(
      "CLIENT TOKEN:",
      ZAPI_CLIENT_TOKEN
    );

    console.log("================================");

    if (
      !ZAPI_INSTANCE ||
      !ZAPI_TOKEN ||
      !ZAPI_CLIENT_TOKEN
    ) {

      console.log(
        "ERRO: Variáveis ZAPI ausentes"
      );

      return;

    }

    const url =
`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;

    console.log(
      "URL:",
      url
    );

    const response =
      await axios.post(

        url,

        {
          phone,
          message: texto
        },

        {
          headers: {

            "Client-Token":
              ZAPI_CLIENT_TOKEN,

            "Content-Type":
              "application/json"

          }
        }

      );

    console.log(
      "ENVIADO:"
    );

    console.log(
      JSON.stringify(
        response.data,
        null,
        2
      )
    );

  } catch (error) {

    console.log(
      "ERRO ZAPI:"
    );

    console.log(
      JSON.stringify(
        error.response?.data,
        null,
        2
      ) ||
      error.message
    );

  }

}
```
