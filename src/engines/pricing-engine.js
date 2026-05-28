const fs = require("fs");
const path = require("path");

const TASAS_PATH = path.join(__dirname, "../config/tasas.json");

function obtenerTasaBRL(monto) {
    try {
        if (!fs.existsSync(TASAS_PATH)) {
            console.log("⚠️ Archivo tasas.json no encontrado");
            return null;
        }
        const data = JSON.parse(fs.readFileSync(TASAS_PATH, "utf8"));
        const faixas = data.brl_cup?.faixas || [];
        const faixa = faixas.find(f => monto >= f.min && monto <= f.max);
        return faixa ? faixa.tasa : null;
    } catch (e) {
        console.error("❌ Error en pricing-engine:", e.message);
        return null;
    }
}

module.exports = { obtenerTasaBRL };
