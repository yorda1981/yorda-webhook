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

// Cotización INVERSA CUP -> BRL por tramos: cuántos reales hacen falta para
// que lleguen `montoCUP`. Misma matemática que ya usaban el bot
// (cotizarCUPInverso en cotizacion-flow.js) y la calculadora web -- se
// extrae aquí para que el alta manual del dashboard la reutilice sin
// duplicarla.
function calcularCUPInversoConTasas(montoCUP, tasas) {
    const tramos = [
        { min: 0,    max: 99,     tasa: Number(tasas.brl_0)    },
        { min: 100,  max: 499,    tasa: Number(tasas.brl_100)  },
        { min: 500,  max: 999,    tasa: Number(tasas.brl_500)  },
        { min: 1000, max: 999999, tasa: Number(tasas.brl_1000) },
    ];

    let realesNecesarios = null, tasaUsada = null;
    for (const tr of tramos) {
        const est = montoCUP / tr.tasa;
        if (est >= tr.min && est <= tr.max) {
            realesNecesarios = Math.ceil(est);
            tasaUsada = tr.tasa;
            break;
        }
    }
    if (!realesNecesarios) {
        tasaUsada = Number(tasas.brl_1000);
        realesNecesarios = Math.ceil(montoCUP / tasaUsada);
    }
    return { realesNecesarios, tasaUsada };
}

// Transferencia por CANTIDAD A RECIBIR (CUP/USD/MLC) -> BRL a pagar. Mismas
// fórmulas que la calculadora web (public/calculadora.html, calcular()):
// CUP por tramos inversos; USD/MLC = floor(cantidad * tasa en R$). Devuelve
// null si falta la tasa correspondiente (nunca inventa una).
function calcularTransferenciaManual({ moneda, cantidad, tasas }) {
    const m = String(moneda || "").toUpperCase();
    const v = Number(cantidad);
    if (!tasas || !Number.isFinite(v) || v <= 0) return null;

    if (m === "CUP") {
        const tramosOk = ["brl_0", "brl_100", "brl_500", "brl_1000"].every(k => Number(tasas[k]) > 0);
        if (!tramosOk) return null;
        const { realesNecesarios, tasaUsada } = calcularCUPInversoConTasas(v, tasas);
        return { moneda: "CUP", tipo: "cup_transferencia", cantidad: v, brl: realesNecesarios, tasa: tasaUsada, tasaEtiqueta: "CUP/BRL" };
    }
    if (m === "USD" || m === "MLC") {
        const tasa = Number(m === "USD" ? tasas.usd1 : tasas.mlc) || 0;
        if (tasa <= 0) return null;
        return { moneda: m, tipo: `${m.toLowerCase()}_transferencia`, cantidad: v, brl: Math.floor(v * tasa), tasa, tasaEtiqueta: `BRL/${m}` };
    }
    return null;
}

async function calcularOperacion({ tipo, valor, nivelVip }) {
    const tasas = await leerTasas();
    return calcularConTasas({ tipo, valor, tasas, nivelVip });
}

module.exports = { calcularOperacion, calcularConTasas, calcularCUPInversoConTasas, calcularTransferenciaManual };
