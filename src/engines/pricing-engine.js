```js id="6blqza"
const fs = require("fs");
const path = require("path");

const TASAS_PATH =
    path.join(
        __dirname,
        "../config/tasas.json"
    );

function leerTasas() {

    try {

        const raw =
            fs.readFileSync(
                TASAS_PATH,
                "utf8"
            );

        return JSON.parse(raw);

    } catch (e) {

        console.log(
            "❌ Error leyendo tasas:",
            e.message
        );

        return {

            brl_cup: {
                faixas: []
            },

            usd_clasica: {
                tasa: 0
            },

            usd_prepago: {
                tasa: 0
            }
        };
    }
}

function calcularOperacion({
    tipo,
    valor
}) {

    const tasas =
        leerTasas();

    const monto =
        Number(valor);

    // =====================
    // BRL → CUP
    // =====================

    if (tipo === "brl_cup") {

        const faixa =
            tasas.brl_cup.faixas.find(

                f =>

                    monto >= f.min &&
                    monto <= f.max
            );

        if (!faixa) {

            throw new Error(
                "FAIXA_NOT_FOUND"
            );
        }

        const cup =
            Math.floor(
                monto * faixa.tasa
            );

        return {

            valor: monto,

            tasa:
                faixa.tasa,

            cup
        };
    }

    // =====================
    // USD CLÁSICA
    // =====================

    if (tipo === "usd_clasica") {

        return {

            valor: monto,

            tasa:
                tasas.usd_clasica.tasa,

            cup:
                Math.floor(
                    monto *
                    tasas.usd_clasica.tasa
                )
        };
    }

    // =====================
    // USD PREPAGO
    // =====================

    if (tipo === "usd_prepago") {

        return {

            valor: monto,

            tasa:
                tasas.usd_prepago.tasa,

            cup:
                Math.floor(
                    monto *
                    tasas.usd_prepago.tasa
                )
        };
    }

    return null;
}

module.exports = {
    calcularOperacion
};
```
