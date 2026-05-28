const express = require("express");
const fs = require("fs");
const path = require("path");

require("dotenv").config();

const app = express();

// ==========================================
// MIDDLEWARES
// ==========================================

app.use(
    express.json({
        limit: "10mb"
    })
);

app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        )
    )
);

// ==========================================
// CONFIG
// ==========================================

const TASAS_PATH =
    path.join(
        __dirname,
        "src",
        "config",
        "tasas.json"
    );

// ==========================================
// PROTECCIÓN ADMIN
// ==========================================

const verificarToken =
    (
        req,
        res,
        next
    ) => {

        const token =
            req.query.token;

        const secret =
            (
                process.env.ADMIN_TOKEN ||
                "yorda123"
            ).trim();

        if (
            !token ||
            token.trim() !== secret
        ) {

            return res
                .status(401)
                .send(
                    "<h1>🔒 No autorizado</h1>"
                );
        }

        next();
    };

// ==========================================
// WEBHOOK
// ==========================================

app.post(
    "/webhook",

    async (
        req,
        res
    ) => {

        // RESPUESTA INMEDIATA
        res
            .status(200)
            .send("OK");

        try {

            const body =
                req.body;

            // ==========================================
            // VALIDAR BODY
            // ==========================================

            if (!body) {

                console.log(
                    "🚫 Body vacío"
                );

                return;
            }

            // ==========================================
            // DEBUG PAYLOAD
            // ==========================================

            console.log(
                "📦 PAYLOAD:"
            );

            console.log(
                JSON.stringify(
                    body,
                    null,
                    2
                )
            );

            // ==========================================
            // IGNORAR MENSAJES PROPIOS
            // ==========================================

            if (
                body.fromMe === true ||
                body.fromMe === "true"
            ) {

                console.log(
                    "🚫 Mensaje propio ignorado"
                );

                return;
            }

            // ==========================================
            // IGNORAR GRUPOS / NEWSLETTER
            // ==========================================

            if (
                body.isGroup === true ||
                body.isNewsletter === true
            ) {

                console.log(
                    "🚫 Grupo/Newsletter ignorado"
                );

                return;
            }

            // ==========================================
            // EXTRAER DATOS
            // ==========================================

            const phone =
                body.phone ||
                body.from ||
                "";

            const textMessage =
                body.text?.message ||
                body.body ||
                "";

            // ==========================================
            // VALIDAR MENSAJE
            // ==========================================

            if (
                !phone ||
                !textMessage ||
                textMessage.trim() === ""
            ) {

                console.log(
                    "⚠️ Mensaje inválido"
                );

                return;
            }

            console.log(
                `📩 Mensaje de: ${
                    body.senderName ||
                    phone
                }`
            );

            console.log(
                `📝 Texto: ${textMessage}`
            );

            // ==========================================
            // OPENAI SERVICE
            // ==========================================

            const openaiService =
                require(
                    "./src/services/openai"
                );

            if (
                typeof
                openaiService.procesarMensaje
                !== "function"
            ) {

                throw new Error(
                    "procesarMensaje no exportado"
                );
            }

            console.log(
                `🤖 IA trabajando para ${phone}...`
            );

            // ==========================================
            // GENERAR RESPUESTA IA
            // ==========================================

            const respuestaIA =
                await openaiService
                    .procesarMensaje(
                        phone,
                        textMessage
                    );

            // ==========================================
            // DEBUG RESPUESTA IA
            // ==========================================

            console.log(
                "🧠 RESPUESTA IA:"
            );

            console.log(
                respuestaIA
            );

            // ==========================================
            // VALIDAR RESPUESTA
            // ==========================================

            if (
                !respuestaIA ||
                respuestaIA.trim() === ""
            ) {

                console.log(
                    "❌ IA devolvió vacío"
                );

                return;
            }

            console.log(
                "✅ Respuesta enviada."
            );

        } catch (e) {

            console.error(
                "💥 ERROR EN WEBHOOK:"
            );

            console.error(e);
        }
    }
);

// ==========================================
// ADMIN STATS
// ==========================================

app.get(
    "/admin/stats",

    verificarToken,

    async (
        req,
        res
    ) => {

        try {

            let stats = {

                clientes: 0,

                vip: 0,

                operaciones: 0,

                total: 0
            };

            return res.json(stats);

        } catch (e) {

            return res
                .status(500)
                .json({
                    error: e.message
                });
        }
    }
);

// ==========================================
// GET TASAS
// ==========================================

app.get(
    "/admin/tasas",

    verificarToken,

    (
        req,
        res
    ) => {

        try {

            if (
                !fs.existsSync(
                    TASAS_PATH
                )
            ) {

                return res.json({});
            }

            const data =
                JSON.parse(

                    fs.readFileSync(
                        TASAS_PATH,
                        "utf8"
                    )
                );

            return res.json({

                brl_0:
                    data.brl_cup?.faixas?.[0]?.tasa || 0,

                brl_100:
                    data.brl_cup?.faixas?.[1]?.tasa || 0,

                brl_500:
                    data.brl_cup?.faixas?.[2]?.tasa || 0,

                brl_1000:
                    data.brl_cup?.faixas?.[3]?.tasa || 0,

                usd1:
                    data.usd_clasica?.tasa || 0,

                usd2:
                    data.usd_prepago?.tasa || 0
            });

        } catch (e) {

            return res
                .status(500)
                .json({
                    error: e.message
                });
        }
    }
);

// ==========================================
// POST TASAS
// ==========================================

app.post(
    "/admin/tasas",

    verificarToken,

    (
        req,
        res
    ) => {

        try {

            const {

                brl_0,
                brl_100,
                brl_500,
                brl_1000,
                usd1,
                usd2

            } = req.body;

            const nuevasTasas = {

                brl_cup: {

                    faixas: [

                        {
                            min: 0,
                            max: 99,
                            tasa: Number(brl_0)
                        },

                        {
                            min: 100,
                            max: 499,
                            tasa: Number(brl_100)
                        },

                        {
                            min: 500,
                            max: 999,
                            tasa: Number(brl_500)
                        },

                        {
                            min: 1000,
                            max: 999999,
                            tasa: Number(brl_1000)
                        }
                    ]
                },

                usd_clasica: {
                    tasa: Number(usd1)
                },

                usd_prepago: {
                    tasa: Number(usd2)
                }
            };

            fs.writeFileSync(

                TASAS_PATH,

                JSON.stringify(
                    nuevasTasas,
                    null,
                    2
                )
            );

            console.log(
                "💾 Tasas actualizadas"
            );

            return res.json({
                success: true
            });

        } catch (e) {

            return res
                .status(500)
                .json({
                    success: false,
                    error: e.message
                });
        }
    }
);

// ==========================================
// DASHBOARD
// ==========================================

app.get(
    "/dashboard",

    verificarToken,

    (
        req,
        res
    ) => {

        res.sendFile(

            path.join(
                __dirname,
                "public",
                "dashboard.html"
            )
        );
    }
);

// ==========================================
// HOME
// ==========================================

app.get(
    "/",

    (
        req,
        res
    ) => {

        res.send(
            "YordaBot Online 🚀"
        );
    }
);

// ==========================================
// SERVER
// ==========================================

const PORT =
    process.env.PORT ||
    8080;

app.listen(
    PORT,
    "0.0.0.0",

    () => {

        console.log(
            `✅ SERVER UP > Puerto ${PORT}`
        );
    }
);
