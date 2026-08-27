const pool = require("../../db");

async function leerTasas() {
    try {
        const result = await pool.query("SELECT * FROM rates LIMIT 1");
        if (result.rows.length === 0) {
            console.error("❌ No hay tasas en PostgreSQL");
            return null;
        }
        return result.rows[0];
    } catch (err) {
        console.error("❌ Error leyendo tasas PostgreSQL:", err.message);
        return null;
    }
}

// Lógica pura de cálculo — no toca la base de datos, así se puede probar sola
// (ver test/calculator.test.js). calcularOperacion() de abajo es solo el que
// lee las tasas de la DB y se las pasa a esta.
function calcularConTasas({ tipo, valor, tasas, nivelVip }) {
    if (!tasas) return null;
    const monto = Number(valor);
    const nivel = Number(nivelVip || 0);
    const bonoVip = nivel === 3 ? Number(tasas.bono_vip_3 || 0)
        : nivel === 2 ? Number(tasas.bono_vip_2 || 0)
        : nivel === 1 ? Number(tasas.bono_vip_1 || 0)
        : 0;

    if (tipo === "brl_cup") {
        let tasa = 0;
        if (monto < 100)       tasa = Number(tasas.brl_0);
        else if (monto < 500)  tasa = Number(tasas.brl_100);
        else if (monto < 1000) tasa = Number(tasas.brl_500);
        else                   tasa = Number(tasas.brl_1000);
        tasa += bonoVip;
        return { valor: monto, tasa, cup: Math.floor(monto * tasa) };
    }

    if (tipo === "usd_clasica") {
        return { valor: monto, tasa: Number(tasas.usd1), cup: Math.floor(monto * Number(tasas.usd1)) };
    }

    if (tipo === "usd_prepago" || tipo === "usd_pendiente_tipo") {
        return { valor: monto, tasa: Number(tasas.usd2), cup: Math.floor(monto * Number(tasas.usd2)) };
    }

    if (tipo === "usd_efectivo") {
        return { valor: monto, tasa: Number(tasas.usd1), brl: Math.floor(monto * Number(tasas.usd1)) };
    }

    if (tipo === "mlc") {
        return { valor: monto, tasa: Number(tasas.mlc || 0), cup: Math.floor(monto * Number(tasas.mlc || 0)) };
    }

    return null;
}

async function calcularOperacion({ tipo, valor, nivelVip }) {
    const tasas = await leerTasas();
    return calcularConTasas({ tipo, valor, tasas, nivelVip });
}

module.exports = { calcularOperacion, calcularConTasas };
