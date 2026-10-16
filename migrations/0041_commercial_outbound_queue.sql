-- Shared, persistent pacing for proactive one-to-one commercial WhatsApp.
-- The queue is deliberately separate from transactional bot replies and the
-- daily-rate publisher.
CREATE TABLE IF NOT EXISTS commercial_outbound_settings (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    paused BOOLEAN NOT NULL DEFAULT TRUE,
    daily_limit INTEGER NOT NULL DEFAULT 10 CHECK (daily_limit BETWEEN 1 AND 10),
    opening_time TIME NOT NULL DEFAULT '09:00',
    closing_time TIME NOT NULL DEFAULT '18:00',
    time_zone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by TEXT
);
INSERT INTO commercial_outbound_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS commercial_outbound_events (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commercial_outbound_queue (
    id BIGSERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('QUOTE_FOLLOWUP','RECUPERACION','CAMPAIGN','REFERRAL','DIRECTOR','VIP')),
    reason TEXT NOT NULL,
    strategy TEXT NOT NULL,
    content TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','SENDING','SENT','CANCELLED','FAILED','UNKNOWN')),
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    error TEXT,
    contact_event_id BIGINT REFERENCES commercial_contact_events(id),
    recovery_attempt_id BIGINT REFERENCES recuperacion_envios(id),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_commercial_outbound_due
    ON commercial_outbound_queue (scheduled_at, id) WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_commercial_outbound_phone_history
    ON commercial_outbound_queue (phone, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commercial_outbound_one_pending_per_phone
    ON commercial_outbound_queue (phone) WHERE state IN ('PENDING','SENDING','UNKNOWN');

ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketing_consent_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketing_consent_source TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketing_consent_message_id TEXT;

ALTER TABLE recuperacion_envios DROP CONSTRAINT IF EXISTS recuperacion_envios_estado_check;
ALTER TABLE recuperacion_envios ADD CONSTRAINT recuperacion_envios_estado_check
    CHECK (estado IN ('EN_COLA','ENVIANDO','ENVIADO','FALLIDO','INCIERTO','EXPIRADO','CANCELADO'));
DROP INDEX IF EXISTS idx_recuperacion_envios_phone_activo;
CREATE UNIQUE INDEX idx_recuperacion_envios_phone_activo
    ON recuperacion_envios (phone)
    WHERE estado IN ('EN_COLA','ENVIANDO','ENVIADO','INCIERTO');
