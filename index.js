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

      (err, uid) => {

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
        // BUSCAR LEAD EXISTENTE
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

          (err, leads) => {

            if (err) {

              return logger(
                "error",
                "ODOO_SEARCH_ERROR",
                {
                  err: err.message
                }
              );
            }

            // =========================
            // SI EXISTE → UPDATE
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

                (err) => {

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
                }
              );
            }

            // =========================
            // SI NO EXISTE → CREATE
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

              (err, res) => {

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
