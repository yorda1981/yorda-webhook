-- Updated referral pilot terms. The program configuration row is updated
-- through the existing authenticated administrative configuration service;
-- this migration only adds new lifecycle fields and safer future defaults.
ALTER TABLE referral_program_config
    ALTER COLUMN max_reward_brl SET DEFAULT 50,
    ALTER COLUMN campaign_limit_brl SET DEFAULT 500,
    ALTER COLUMN period_limit_brl SET DEFAULT 500;

ALTER TABLE customer_referrals
    ADD COLUMN IF NOT EXISTS participation_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;

-- Deliberately do not backfill participation_expires_at: previous participants
-- must not receive a newly imposed retroactive deadline.
CREATE INDEX IF NOT EXISTS idx_customer_referrals_expiry
    ON customer_referrals (participation_expires_at, id)
    WHERE status = 'PENDIENTE' AND participation_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customer_referrals_expired
    ON customer_referrals (expired_at DESC)
    WHERE expired_at IS NOT NULL;
