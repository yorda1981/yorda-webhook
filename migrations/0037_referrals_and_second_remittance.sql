-- Captación por referidos y seguimiento prudente de primera a segunda remesa.
-- El programa nace desactivado y sin límites económicos implícitos.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS referral_code VARCHAR(10);
ALTER TABLE operations
    ADD COLUMN IF NOT EXISTS es_prueba BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_referral_code
    ON customers (referral_code) WHERE referral_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS referral_program_config (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    reward_pct NUMERIC(5,2) NOT NULL DEFAULT 1.00 CHECK (reward_pct > 0 AND reward_pct <= 1.00),
    max_reward_brl NUMERIC(12,2) CHECK (max_reward_brl IS NULL OR max_reward_brl > 0),
    campaign_limit_brl NUMERIC(12,2) CHECK (campaign_limit_brl IS NULL OR campaign_limit_brl > 0),
    period_limit_brl NUMERIC(12,2) CHECK (period_limit_brl IS NULL OR period_limit_brl > 0),
    unknown_net_profit_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
    enabled_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by VARCHAR(120)
);
INSERT INTO referral_program_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS customer_referrals (
    id BIGSERIAL PRIMARY KEY,
    referral_code VARCHAR(10) NOT NULL,
    referrer_phone VARCHAR(40) NOT NULL REFERENCES customers(phone),
    referred_phone VARCHAR(40) NOT NULL UNIQUE REFERENCES customers(phone),
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    evidence VARCHAR(40) NOT NULL CHECK (evidence IN ('WHATSAPP_CODE','ADMIN_VERIFIED')),
    evidence_note TEXT,
    first_operation_id INTEGER UNIQUE REFERENCES operations(id),
    eligible_at TIMESTAMPTZ,
    first_amount_brl NUMERIC(12,2) CHECK (first_amount_brl IS NULL OR first_amount_brl > 0),
    reward_pct NUMERIC(5,2) NOT NULL,
    reward_brl NUMERIC(12,2) CHECK (reward_brl IS NULL OR reward_brl >= 0),
    status VARCHAR(24) NOT NULL DEFAULT 'PENDIENTE'
        CHECK (status IN ('PENDIENTE','ELEGIBLE','REVISION','APROBADA','LIQUIDADA','RECHAZADA','CANCELADA','REVISION_REVERSO')),
    status_reason TEXT,
    approved_at TIMESTAMPTZ,
    approved_by VARCHAR(120),
    settled_at TIMESTAMPTZ,
    settled_by VARCHAR(120),
    settlement_method VARCHAR(60),
    settlement_reference VARCHAR(160),
    reversed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (referrer_phone <> referred_phone)
);
CREATE INDEX IF NOT EXISTS idx_customer_referrals_status_date
    ON customer_referrals (status, linked_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_referrals_referrer
    ON customer_referrals (referrer_phone, linked_at DESC);

CREATE TABLE IF NOT EXISTS customer_referral_events (
    id BIGSERIAL PRIMARY KEY,
    referral_id BIGINT NOT NULL REFERENCES customer_referrals(id) ON DELETE CASCADE,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor VARCHAR(120) NOT NULL,
    action VARCHAR(32) NOT NULL,
    from_status VARCHAR(24),
    to_status VARCHAR(24),
    details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_customer_referral_events_referral
    ON customer_referral_events (referral_id, occurred_at DESC);
