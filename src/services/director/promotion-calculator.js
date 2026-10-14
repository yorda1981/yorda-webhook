"use strict";

const pool = require("../../../db");
const calculator = require("../calculator");
const crypto = require("node:crypto");

const MARGIN_REFERENCE_PCT = 5;
const MAX_PROMOTION_PCT = 2;
const SAMPLE_AMOUNTS_BRL = Object.freeze([100, 500, 1000]);
const RATE_FIELDS = Object.freeze(["brl_0", "brl_100", "brl_500", "brl_1000"]);

function money(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function unavailable(reason, updatedAt = null) {
    return {
        disponible: false, motivo: reason, updatedAt, revision: null,
        margenReferenciaPct: MARGIN_REFERENCE_PCT,
        maxBeneficioPct: MAX_PROMOTION_PCT,
        rentabilidadVerificada: false,
        escenarios: []
    };
}

function buildScenarios(rates, updatedAt, now = new Date(), existingBenefits = { known: true, active: [] }) {
    if (!rates || RATE_FIELDS.some(field => !Number.isFinite(Number(rates[field])) || Number(rates[field]) <= 0)) {
        return unavailable("Falta una tasa CUP/BRL válida en uno o más tramos.", updatedAt || null);
    }
    const date = updatedAt ? new Date(updatedAt) : null;
    const updatedAtIso = date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
    const revisionFields = [...RATE_FIELDS, "bono_vip_1", "bono_vip_2", "bono_vip_3"];
    const revisionInput = JSON.stringify({
        rates: Object.fromEntries(revisionFields.map(field => [field, Number(rates[field] || 0)])),
        benefitsKnown: existingBenefits.known !== false,
        benefits: existingBenefits.active || []
    });
    const revision = crypto.createHash("sha256").update(revisionInput).digest("hex");

    const escenarios = SAMPLE_AMOUNTS_BRL.flatMap(amountBRL => [0, 1, 2, 3].map(nivelVip => {
        const normal = calculator.calcularConTasas({ tipo: "brl_cup", valor: amountBRL, tasas: rates, nivelVip });
        const normalSinVip = calculator.calcularConTasas({ tipo: "brl_cup", valor: amountBRL, tasas: rates, nivelVip: 0 });
        if (!normal || !Number.isFinite(normal.tasa) || normal.tasa <= 0) return null;
        const margenReferenciaBRL = money(amountBRL * MARGIN_REFERENCE_PCT / 100);
        const beneficioVipExistenteBRL = nivelVip > 0 && normalSinVip?.tasa > 0
            ? money(Math.max(0, normal.cup - normalSinVip.cup) / normalSinVip.tasa) : 0;
        const activeBenefitsUnknown = existingBenefits.known === false || existingBenefits.active?.length > 0;
        const marginAfter = cost => activeBenefitsUnknown ? null
            : money(margenReferenciaBRL - beneficioVipExistenteBRL - cost);
        const marginAfterPct = value => value === null ? null : money(value / amountBRL * 100);
        const descuentos = [1, 2].map(porcentaje => {
            const costoBeneficioBRL = money(amountBRL * porcentaje / 100);
            return {
                tipo: "DESCUENTO_TRANSFERENCIA", porcentaje,
                importeTransferenciaBRL: amountBRL,
                pagaClienteBRL: money(amountBRL - costoBeneficioBRL),
                recibeNormalCUP: normal.cup,
                recibePromocionCUP: normal.cup,
                tasaNormal: normal.tasa,
                costoBeneficioBRL,
                beneficioVipExistenteBRL,
                margenReferenciaRestanteBRL: marginAfter(costoBeneficioBRL),
                margenReferenciaRestantePct: marginAfterPct(marginAfter(costoBeneficioBRL)),
                rentabilidadVerificada: false
            };
        });
        const mejorasTasa = [1, 2].map(porcentaje => {
            const tasaPromocional = normal.tasa * (1 + porcentaje / 100);
            const recibePromocionCUP = Math.floor(amountBRL * tasaPromocional);
            const beneficioCUP = recibePromocionCUP - normal.cup;
            // Equivalencia al tipo de cambio normal; no sustituye el costo real de liquidación.
            const costoBeneficioBRL = money(beneficioCUP / normal.tasa);
            return {
                tipo: "MEJORA_TASA", porcentaje,
                importeTransferenciaBRL: amountBRL,
                pagaClienteBRL: amountBRL,
                recibeNormalCUP: normal.cup,
                recibePromocionCUP,
                tasaNormal: normal.tasa,
                tasaPromocional,
                mejoraTasaPct: porcentaje,
                aumentoTasaCUPPorBRL: money(tasaPromocional - normal.tasa),
                beneficioCUP,
                costoBeneficioBRL,
                beneficioVipExistenteBRL,
                margenReferenciaRestanteBRL: marginAfter(costoBeneficioBRL),
                margenReferenciaRestantePct: marginAfterPct(marginAfter(costoBeneficioBRL)),
                rentabilidadVerificada: false
            };
        });
        return { importeTransferenciaBRL: amountBRL, nivelVip, tasaActualizadaAt: updatedAtIso, normal: {
            tasa: normal.tasa, recibeCUP: normal.cup, bonoVipCUPPorBRL: money(normal.tasa - normalSinVip.tasa),
            beneficioVipExistenteBRL
        }, descuentos, mejorasTasa };
    })).filter(Boolean);

    if (escenarios.length !== SAMPLE_AMOUNTS_BRL.length * 4) return unavailable("No se pudo calcular un tramo de la cotización actual.", updatedAtIso);
    return {
        disponible: true, motivo: null, updatedAt: updatedAtIso, revision,
        zonaHoraria: "America/Sao_Paulo", margenReferenciaPct: MARGIN_REFERENCE_PCT,
        maxBeneficioPct: MAX_PROMOTION_PCT, rentabilidadVerificada: false,
        notaEscenarios: "Montos comparativos de referencia por tramo: R$100, R$500 y R$1.000; no son cotizaciones de clientes concretos.",
        beneficiosExistentes: existingBenefits.active || [],
        beneficiosExistentesConCostoDesconocido: existingBenefits.known === false || (existingBenefits.active || []).length > 0,
        notaRentabilidad: "El margen del 5 % es una referencia comercial, no un costo/margen neto verificado. El restante es teórico; no autoriza la promoción.",
        conversionCostoNota: "El costo BRL de mejora de tasa es el equivalente de CUP adicional dividido por la tasa normal; no sustituye el costo real de liquidación.",
        escenarios
    };
}

async function getCurrentPromotionScenarios(db = pool, now = new Date()) {
    try {
        const result = await db.query("SELECT * FROM rates WHERE id = 1 LIMIT 1");
        const row = result.rows[0];
        if (!row) return unavailable("No existe una fila de tasas vigente (rates.id = 1). ");
        let existingBenefits = { known: true, active: [] };
        try {
            const offersResult = await db.query("SELECT activa, vence_at, texto, activa_vip, texto_vip FROM ofertas WHERE id = 1 LIMIT 1");
            const offers = offersResult.rows[0];
            if (offers) {
                const nowMs = new Date(now).getTime();
                const commonActive = Boolean(offers.activa) && (!offers.vence_at || new Date(offers.vence_at).getTime() > nowMs);
                const vipActive = Boolean(offers.activa_vip && offers.texto_vip);
                if (commonActive) existingBenefits.active.push({ segmento: "general", texto: String(offers.texto || "").slice(0, 300), costoCuantificado: false });
                if (vipActive) existingBenefits.active.push({ segmento: "VIP", texto: String(offers.texto_vip || "").slice(0, 300), costoCuantificado: false });
            }
        } catch (_) {
            existingBenefits = { known: false, active: [] };
        }
        return buildScenarios(row, row.updated_at, now, existingBenefits);
    } catch (error) {
        return unavailable(`No se pudo leer la tabla rates: ${String(error.message || "error de base de datos").slice(0, 180)}`);
    }
}

function findOfferScenario(context, offer) {
    if (!context?.disponible || !offer) return null;
    const type = String(offer.tipo || "").toUpperCase();
    const percentage = Number(offer.porcentaje);
    if (![1, 2].includes(percentage)) return null;
    return context.escenarios.map(item => {
        const list = type === "DESCUENTO_TRANSFERENCIA" ? item.descuentos
            : type === "MEJORA_TASA" ? item.mejorasTasa : [];
        return list.find(candidate => candidate.porcentaje === percentage);
    }).filter(Boolean);
}

module.exports = {
    MARGIN_REFERENCE_PCT, MAX_PROMOTION_PCT, SAMPLE_AMOUNTS_BRL,
    buildScenarios, getCurrentPromotionScenarios, findOfferScenario
};
