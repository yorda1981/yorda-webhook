const fs = require("fs");
const path = require("path");

const TASAS_PATH = path.join(__dirname, "../config/tasas.json");

function leerTasas() {
    try {
        if (!fs.existsSync(TASAS_PATH)) return null;
        const raw = fs.readFileSync(TASAS_PATH, "utf8");
        return JSON.parse(raw);
    } catch (e) {
        console.error("Error leyendo tasas.json:", e.message);
        return null;
    }
}

function calcularOperacion({ tipo, valor }) {
    const tasas = leerTasas();
    if (!tasas) return null;

    const monto = Number(valor);

    if (tipo === "brl_cup") {
        const faixa = tasas.brl_cup.faixas.find(f => monto >= f.min && monto <= f.max);
        if (!faixa) return null;
        return { valor: monto, tasa: faixa.tasa, cup: Math.floor(monto * faixa.tasa) };
    }

    if (tipo === "usd_clasica") {
        return { valor: monto, tasa: tasas.usd_clasica.tasa, cup: Math.floor(monto * tasas.usd_clasica.tasa) };
    }

    return null;
}

module.exports = { calcularOperacion };
