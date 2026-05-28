```js
const fs = require("fs");
const path = require("path");

const TASAS_PATH = path.join(__dirname, "../config/tasas.json");

function obtenerTasaBRL(monto) {

    try {

        const data = JSON.parse(
            fs.readFileSync(
                TASAS_PATH,
                "utf8"
            )
        );

        const faixa =
            data.brl_cup.faixas.find(
                f =>
                    monto >= f.min &&
                    monto <= f.max
            );

        return faixa
            ? faixa.tasa
            : null;

    } catch (e) {

        console.error(
            "Error en pricing-engine:",
            e.message
        );

        return null;
    }
}

module.exports = {
    obtenerTasaBRL
};
```
