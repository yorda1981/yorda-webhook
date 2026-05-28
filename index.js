
const express = require("express");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");

require("dotenv").config();

// ==========================================
// IMPORTS
// ==========================================

const openaiService =
    require("./src/services/openai");

const {
    obtenerPromo,
    guardarPromo
} = require(
    "./src/services/promo"
);

// ==========================================
// APP
// ==========================================

const app = express();

// ==========================================
// RAILWAY / PROXY
// ==========================================

app.set(
    "trust proxy",
    1
);

// ==========================================
// BUFFER ANTI-SPAM
// ==========================================

const buffers =
    new Map();

const lastResponses =
    new Map();

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
// RATE LIMITING
// ==========================================

const webhookLimiter =
    rateLimit({

        windowMs:
            60 * 1000,

        max:
            300,

        message: {

            error:
                "Demasiadas solicitudes"
        },

        standardHeaders:
            true,

        legacyHeaders:
            false
    });

const adminLimiter =
    rateLimit({

        windowMs:
            15 * 60 * 1000,

        max:
            50,

        message: {

            error:
                "Demasiadas solicitudes admin"
        }
    });

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

const verificarToken = (

    req,
    res,
    next

) => {

    const token =

        req.headers["x-admin-token"]

        ||

        req.query.token;

    const secret =
        process.env.ADMIN_TOKEN?.trim();

    if (!secret) {

        console.error(
            "⚠️ ADMIN_TOKEN no definido"
        );

        return res
            .status(500)
            .send(
                "<h1>Error configuración servidor</h1>"
            );
    }

    if (

        !token ||

        token.trim() !== secret

    ) {

        return res
            .status(401)
            .json({

                error:
                    "No autorizado"
            });
    }

    next();
};

// ==========================================
// WEBHOOK
// ==========================================

app.post(

    "/webhook",

    webhookLimiter,

    async (

        req,
        res

    ) => {

        res
            .status(200)
            .send("OK");

        try {

            const body =
                req.body;

            if (!body) return;

            // ==========================================
            // SOLO MENSAJES REALES
            // ==========================================

            if (

                body.type !==
                "ReceivedCallback"

            ) {

                console.log(

                    `🔕 Callback ignorado: ${
                        body.type || "sin tipo"
                    }`
                );

                return;
            }

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
            // IGNORAR GRUPOS
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

            const phone =

                body.phone ||

                body.from;

            const textMessage =

                body.text?.message ||

                body.body ||

                body.message;

            // ==========================================
            // VALIDAR TELÉFONO
            // ==========================================

            if (!phone) {

                console.log(
                    "⚠️ Teléfono inválido"
                );

                return;
            }

            // ==========================================
            // IGNORAR EVENTOS SIN TEXTO
            // ==========================================

            if (

                !textMessage ||

                typeof textMessage !== "string"

            ) {

                console.log(
                    "🔕 Evento sin texto ignorado"
                );

                return;
            }

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
                `📩 Mensaje de: ${
                    body.senderName || phone
                }`
            );

            // ==========================================
            // GUARDAR ÚLTIMO MENSAJE
            // ==========================================

            pendingMessages.set(
                phone,
                textMessage
            );

            // ==========================================
            // REINICIAR BUFFER
            // ==========================================

            if (
                buffers.has(phone)
            ) {

                clearTimeout(
                    buffers.get(phone)
                );

                console.log(
                    `⏳ Buffer reiniciado para ${phone}`
                );
            }

            // ==========================================
            // NUEVO TIMER
            // ==========================================

            buffers.set(

                phone,

                setTimeout(

                    async () => {

                        const mensaje =
                            pendingMessages.get(phone);

                        try {

                            console.log(
                                `🤖 IA trabajando para ${phone}...`
                            );

                            await openaiService
                                .procesarMensaje(
                                    phone,
                                    mensaje
                                );

                            console.log( "✅ Respuesta enviada." ); lastResponses.set( phone, Date.now() ); } catch (e) {

                            console.error(
                                "💥 ERROR EN BUFFER:"
                            );

                            console.error(e);

                        } finally {

                            buffers.delete(phone);

                            pendingMessages.delete(phone);
                        }

                    },

                    6000
                )
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

    adminLimiter,

    verificarToken,

    async (

        req,
        res

    ) => {

        try {

            const stats = {

                clientes: 0,
                vip: 0,
                operaciones: 0,
                total: 0
            };

            return res.json(stats);

        } catch (e) {

            console.error(
                "Error /admin/stats"
            );

            console.error(e);

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

    adminLimiter,

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

            console.error(
                "Error GET tasas"
            );

            console.error(e);

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

    adminLimiter,

    verificarToken,

    async (

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

            await fs.promises.writeFile(

                TASAS_PATH,

                JSON.stringify(
                    nuevasTasas,
                    null,
                    2
                )
            );

            return res.json({
                success: true
            });

        } catch (e) {

            console.error(
                "Error POST tasas"
            );

            console.error(e);

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
// GET PROMO
// ==========================================

app.get(

    "/admin/promo",

    adminLimiter,

    verificarToken,

    (

        req,
        res

    ) => {

        try {

            return res.json(
                obtenerPromo()
            );

        } catch (e) {

            console.error(
                "Error GET promo"
            );

            console.error(e);

            return res
                .status(500)
                .json({
                    error: e.message
                });
        }
    }
);

// ==========================================
// POST PROMO
// ==========================================

app.post(

    "/admin/promo",

    adminLimiter,

    verificarToken,

    async (

        req,
        res

    ) => {

        try {

            const ok =

                await guardarPromo(

                    req.body.promo
                );

            return res.json({

                success: ok
            });

        } catch (e) {

            console.error(
                "Error POST promo"
            );

            console.error(e);

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

    adminLimiter,

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
            "YordaBot Online"
        );
    }
);

// ==========================================
// SERVER
// ==========================================

const PORT =
    process.env.PORT ||
    8080;

const server =
    app.listen(

        PORT,

        "0.0.0.0",

        () => {

            console.log(
                `✅ SERVER UP > Puerto ${PORT}`
            );
        }
    );

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

const shutdown = (
    signal
) => {

    console.log(
        `\n${signal} recibido. Cerrando servidor...`
    );

    for (

        const [phone, timer]

        of buffers.entries()

    ) {

        clearTimeout(timer);

        console.log(
            `🧹 Buffer cancelado para ${phone}`
        );
    }

    buffers.clear();

    pendingMessages.clear();

    server.close(() => {

        console.log(
            "✅ Servidor cerrado correctamente."
        );

        process.exit(0);
    });

    setTimeout(() => {

        console.error(
            "⚠️ Cierre forzado"
        );

        process.exit(1);

    }, 10000);
};

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);
