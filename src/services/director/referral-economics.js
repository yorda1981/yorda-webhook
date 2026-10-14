"use strict";

const DEFAULT_MARGIN_REFERENCE_PCT = 5;
const REWARD_PCT = 1;

function money(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }

/** Evaluation only: no referral enrollment, accrual, or payout is performed. */
function evaluateReferralEconomics({ amounts = [100, 500, 1000], marginReferencePct = DEFAULT_MARGIN_REFERENCE_PCT,
    rewardPct = REWARD_PCT, costsKnown = false, vipBenefitsKnown = false } = {}) {
    const validAmounts = amounts.filter(amount => Number.isFinite(Number(amount)) && Number(amount) > 0);
    const scenarios = validAmounts.map(amount => {
        const grossMarginReferenceBRL = money(Number(amount) * marginReferencePct / 100);
        const rewardBRL = money(Number(amount) * rewardPct / 100);
        const remainingReferenceBRL = money(grossMarginReferenceBRL - rewardBRL);
        return {
            transferBRL: Number(amount), rewardPct, rewardBRL,
            grossMarginReferencePct: marginReferencePct,
            grossMarginReferenceBRL,
            remainingReferenceBRL,
            remainingReferencePct: money(remainingReferenceBRL / Number(amount) * 100),
            breakEvenCostBudgetBRL: remainingReferenceBRL,
            netProfitVerified: false,
            status: costsKnown && vipBenefitsKnown ? "PENDIENTE_DE_VALIDAR_COSTO_NETO" : "PENDIENTE_DATOS"
        };
    });
    return {
        candidate: "REFERIDO_PRIMERA_REMESA",
        status: costsKnown && vipBenefitsKnown ? "PENDIENTE_DE_VALIDAR_COSTO_NETO" : "PENDIENTE_DATOS",
        authorized: false,
        rewardCondition: "Una recompensa por referido, únicamente tras confirmar su primera remesa; evitar autorreferidos y duplicados.",
        deliveryMethod: "Pendiente de definir y aprobar; no asumir saldo, efectivo ni aumento de tasa.",
        marginReferencePct, marginReferenceIsNetProfit: false,
        missing: [
            ...(!costsKnown ? ["Costos reales de liquidación, comisiones y operación por transferencia."] : []),
            ...(!vipBenefitsKnown ? ["Costo acumulado de beneficios VIP/ofertas existentes por cliente."] : []),
            "Regla de identidad y antifraude para referidos.",
            "Mecanismo de entrega y control de pago idempotente.",
            "Validación del margen neto mínimo aceptable."
        ],
        scenarios
    };
}

module.exports = { DEFAULT_MARGIN_REFERENCE_PCT, REWARD_PCT, evaluateReferralEconomics };
