const fs = require("fs");
const path = require("path");

const TASAS_PATH = path.join(__dirname, "../config/tasas.json");

function leerTasas() {
    try {
        if (!fs.existsSync(TASAS_PATH)) {
            console.error("❌ tasas.json no existe");
            return null;
        }

        const raw = fs.readFileSync(TASAS_PATH, "utf8");

        if (!raw || raw.trim() === "") {
            console.error("❌ tasas.json vacío");
            return null;
        }

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

    if (!tasas) {
        console.error("❌ No se pudieron cargar las tasas");
        return null;
    }

    const monto = Number(valor);

    // ==========================
    // BRL -> CUP
    // ==========================
    if (
        tipo === "brl_cup" &&
        tasas.brl_cup &&
        Array.isArray(tasas.brl_cup.faixas)
    ) {

        const faixa = tasas.brl_cup.faixas.find(
            f => monto >= f.min && monto <= f.max
        );

        if (!faixa) {
            console.error(
                "❌ No se encontró faixa para:",
                monto
            );
            return null;
        }

        return {
            valor: monto,
            tasa: faixa.tasa,
            cup: Math.floor(monto * faixa.tasa)
        };
    }

    // ==========================
    // USD CLÁSICA
    // ==========================
    if (
        tipo === "usd_clasica" &&
        tasas.usd_clasica
    ) {

        return {
            valor: monto,
            tasa: tasas.usd_clasica.tasa,
            cup: Math.floor(
                monto * tasas.usd_clasica.tasa
            )
        };
    }

    // ==========================
    // USD PREPAGO
    // ==========================
    if (
        tipo === "usd_prepago" &&
        tasas.usd_prepago
    ) {

        return {
            valor: monto,
            tasa: tasas.usd_prepago.tasa,
            cup: Math.floor(
                monto * tasas.usd_prepago.tasa
            )
        };
    }

    console.error(
        "❌ Tipo de operación no soportado:",
        tipo
    );

    return null;
}

module.exports = {
    calcularOperacion
};
