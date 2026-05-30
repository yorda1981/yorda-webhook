const fs = require("fs");
const path = require("path");

const TASAS_PATH = path.join(
    __dirname,
    "../config/tasas.json"
);

function leerTasas() {
    try {

        if (!fs.existsSync(TASAS_PATH)) {
            console.error("❌ tasas.json no encontrado");
            return null;
        }

        const raw = fs.readFileSync(
            TASAS_PATH,
            "utf8"
        );

        const data = JSON.parse(raw);

        console.log(
            "📊 TASAS CARGADAS:",
            JSON.stringify(data, null, 2)
        );

        return data;

    } catch (e) {

        console.error(
            "❌ Error leyendo tasas.json:",
            e.message
        );

        return null;
    }
}

function calcularOperacion({ tipo, valor }) {

    const tasas = leerTasas();

    if (!tasas) return null;

    const monto = Number(valor);

    if (tipo === "brl_cup") {

        let tasa = 0;

        if (monto < 100) {
            tasa = Number(tasas.brl_0);
        } else if (monto < 500) {
            tasa = Number(tasas.brl_100);
        } else if (monto < 1000) {
            tasa = Number(tasas.brl_500);
        } else {
            tasa = Number(tasas.brl_1000);
        }

        return {
            valor: monto,
            tasa,
            cup: Math.floor(monto * tasa)
        };
    }

    if (tipo === "usd_clasica") {

        return {
            valor: monto,
            tasa: Number(tasas.usd1),
            cup: Math.floor(monto * Number(tasas.usd1))
        };
    }

    if (tipo === "usd_prepago") {

        return {
            valor: monto,
            tasa: Number(tasas.usd2),
            cup: Math.floor(monto * Number(tasas.usd2))
        };
    }

    return null;
}

module.exports = {
    calcularOperacion
};
