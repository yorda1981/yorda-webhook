const stageCache = {};

function obtenerStageIdPorNombre(
  models,
  uid,
  nombre
) {

  return new Promise((resolve, reject) => {

    if (stageCache[nombre]) {

      return resolve(
        stageCache[nombre]
      );
    }

    models.methodCall(

      "execute_kw",

      [
        ODOO_DB,
        uid,
        ODOO_API_KEY,

        "crm.stage",
        "search_read",

        [[
          ["name", "=", nombre]
        ]],

        {
          fields: ["id", "name"],
          limit: 1
        }
      ],

      (err, res) => {

        if (err) {
          return reject(err);
        }

        if (
          !res ||
          !res.length
        ) {

          return resolve(null);
        }

        const id =
          res[0].id;

        stageCache[nombre] =
          id;

        resolve(id);
      }
    );
  });
}

function detectarEtapa(texto) {

  const t =
    String(texto || "")
    .toLowerCase();

  // =========================
  // PAGO CONFIRMADO
  // =========================
  if (

    t.includes("pagué") ||
    t.includes("pague") ||
    t.includes("comprobante") ||
    t.includes("listo") ||
    t.includes("hecho")

  ) {

    return "Pago confirmado";
  }

  // =========================
  // FINALIZADO
  // =========================
  if (

    t.includes("finalizado") ||
    t.includes("entregado")

  ) {

    return "Finalizado";
  }

  // =========================
  // TASA ENVIADA
  // =========================
  if (

    t.includes("real") ||
    t.includes("reales") ||
    t.includes("cup") ||
    t.includes("usd") ||
    t.includes("mlc") ||
    t.includes("quiero enviar") ||
    t.includes("cuánto") ||
    t.includes("cuanto")

  ) {

    return "Tasa enviada";
  }

  return "Interesado";
}

async function moverLeadEtapa(
  models,
  uid,
  leadId,
  nombreEtapa
) {

  try {

    const stageId =
      await obtenerStageIdPorNombre(
        models,
        uid,
        nombreEtapa
      );

    if (!stageId) {

      return logger(
        "warn",
        "STAGE_NOT_FOUND",
        {
          nombreEtapa
        }
      );
    }

    models.methodCall(

      "execute_kw",

      [
        ODOO_DB,
        uid,
        ODOO_API_KEY,

        "crm.lead",
        "write",

        [
          [leadId],
          {
            stage_id:
              stageId
          }
        ]
      ],

      (err) => {

        if (err) {

          return logger(
            "error",
            "MOVE_STAGE_ERROR",
            {
              err: err.message
            }
          );
        }

        logger(
          "info",
          "LEAD_STAGE_UPDATED",
          {
            leadId,
            nombreEtapa
          }
        );
      }
    );

  } catch (e) {

    logger(
      "error",
      "MOVE_STAGE_FATAL",
      {
        err: e.message
      }
    );
  }
}

function registrarEnOdoo(datos) {

  try {

    const urlLimpia =
      String(ODOO_URL || "")
      .replace(/\/$/, "");

    const common =
      xmlrpc.createSecureClient({

        url:
`${urlLimpia}/xmlrpc/2/common`
      });

    const models =
      xmlrpc.createSecureClient({

        url:
`${urlLimpia}/xmlrpc/2/object`
      });

    common.methodCall(

      "authenticate",

      [
        ODOO_DB,
        ODOO_USER,
        ODOO_API_KEY,
        {}
      ],

      async (err, uid) => {

        if (err) {

          return logger(
            "error",
            "ODOO_AUTH_ERROR",
            {
              err: err.message
            }
          );
        }

        if (!uid) {

          return logger(
            "error",
            "ODOO_UID_INVALID"
          );
        }

        // =========================
        // SEARCH LEAD
        // =========================
        models.methodCall(

          "execute_kw",

          [
            ODOO_DB,
            uid,
            ODOO_API_KEY,

            "crm.lead",
            "search",

            [[
              ["partner_name", "=", datos.phone]
            ]],

            {
              limit: 1
            }
          ],

          async (err, leads) => {

            if (err) {

              return logger(
                "error",
                "ODOO_SEARCH_ERROR",
                {
                  err: err.message
                }
              );
            }

            const etapaDetectada =
              detectarEtapa(
                datos.mensaje
              );

            // =========================
            // UPDATE
            // =========================
            if (
              leads &&
              leads.length > 0
            ) {

              const leadId =
                leads[0];

              return models.methodCall(

                "execute_kw",

                [
                  ODOO_DB,
                  uid,
                  ODOO_API_KEY,

                  "crm.lead",
                  "write",

                  [
                    [leadId],

                    {
                      description:
`${datos.mensaje}

━━━━━━━━━━
${new Date().toLocaleString()}
`
                    }
                  ]
                ],

                async (err) => {

                  if (err) {

                    return logger(
                      "error",
                      "ODOO_UPDATE_ERROR",
                      {
                        err: err.message
                      }
                    );
                  }

                  logger(
                    "info",
                    "ODOO_LEAD_UPDATED",
                    {
                      id: leadId,
                      phone: datos.phone
                    }
                  );

                  await moverLeadEtapa(
                    models,
                    uid,
                    leadId,
                    etapaDetectada
                  );
                }
              );
            }

            // =========================
            // CREATE
            // =========================
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
`WhatsApp: ${datos.phone}`,

                  partner_name:
                    datos.phone,

                  description:
                    datos.mensaje,

                  type:
                    "opportunity"
                }]]
              ],

              async (err, res) => {

                if (err) {

                  return logger(
                    "error",
                    "ODOO_CREATE_ERROR",
                    {
                      err: err.message
                    }
                  );
                }

                logger(
                  "info",
                  "ODOO_LEAD_CREATED",
                  {
                    id: res,
                    phone: datos.phone
                  }
                );

                await moverLeadEtapa(
                  models,
                  uid,
                  res,
                  etapaDetectada
                );
              }
            );
          }
        );
      }
    );

  } catch (e) {

    logger(
      "error",
      "ODOO_FATAL",
      {
        err: e.message
      }
    );
  }
}
