-- Piloto de referidos de 30 días. La migración configura el piloto, pero
-- permanece apagado; ningún mensaje ni compromiso nuevo se activa aquí.
ALTER TABLE referral_program_config
    ADD COLUMN IF NOT EXISTS duration_days INTEGER NOT NULL DEFAULT 30,
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE referral_program_config
    ALTER COLUMN max_reward_brl SET DEFAULT 20,
    ALTER COLUMN campaign_limit_brl SET DEFAULT 200,
    ALTER COLUMN period_limit_brl SET DEFAULT 200;

UPDATE referral_program_config
SET enabled = FALSE,
    reward_pct = 1,
    max_reward_brl = 20,
    campaign_limit_brl = 200,
    period_limit_brl = 200,
    duration_days = 30,
    expires_at = CASE WHEN enabled_at IS NOT NULL THEN COALESCE(expires_at, enabled_at + INTERVAL '30 days') ELSE NULL END,
    updated_at = NOW(),
    updated_by = 'migration-0038'
WHERE id = 1;

ALTER TABLE referral_program_config
    ALTER COLUMN max_reward_brl SET NOT NULL,
    ALTER COLUMN campaign_limit_brl SET NOT NULL,
    ALTER COLUMN period_limit_brl SET NOT NULL,
    ADD CONSTRAINT referral_program_duration_30 CHECK (duration_days = 30);

ALTER TABLE customer_referrals
    ADD COLUMN IF NOT EXISTS reserved_reward_brl NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (reserved_reward_brl >= 0);

-- Preserva todos los compromisos existentes. Pendientes heredados reservan el
-- máximo del piloto; recompensas calculadas conservan su importe real.
UPDATE customer_referrals
SET reserved_reward_brl = CASE
    WHEN status IN ('RECHAZADA','CANCELADA') THEN 0
    WHEN reward_brl IS NOT NULL AND reward_brl > 0 THEN reward_brl
    WHEN status IN ('PENDIENTE','REVISION') THEN 20
    ELSE 0
END
WHERE reserved_reward_brl = 0;

CREATE TABLE IF NOT EXISTS referral_program_config_events (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor VARCHAR(120) NOT NULL,
    action VARCHAR(32) NOT NULL,
    before_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    after_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_referral_program_config_events_date
    ON referral_program_config_events (occurred_at DESC);

CREATE TABLE IF NOT EXISTS referral_program_events (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    customer_phone VARCHAR(40),
    action VARCHAR(32) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_referral_program_events_date
    ON referral_program_events (action, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_referrals_reserved
    ON customer_referrals (reserved_reward_brl) WHERE reserved_reward_brl > 0;
