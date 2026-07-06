
const fs = require("fs");

const path = require("path");

const PROMO_PATH =
    path.join(

        __dirname,

        "../config/promo.json"
    );

// ==========================================
// OBTENER PROMO
// ==========================================

function obtenerPromo() {

    try {

        if (
            !fs.existsSync(
                PROMO_PATH
            )
        ) {

            return {
                promo: ""
            };
        }

        return JSON.parse(

            fs.readFileSync(
                PROMO_PATH,
                "utf8"
            )
        );

    } catch (e) {

        console.error(
            "❌ Error leyendo promo"
        );

        return {
            promo: ""
        };
    }
}

// ==========================================
// GUARDAR PROMO
// ==========================================

async function guardarPromo(
    texto
) {

    try {

        await fs.promises.writeFile(

            PROMO_PATH,

            JSON.stringify({

                promo:
                    String(texto || "")

            }, null, 2)
        );

        return true;

    } catch (e) {

        console.error(
            "❌ Error guardando promo"
        );

        return false;
    }
}

module.exports = {

    obtenerPromo,

    guardarPromo
};
