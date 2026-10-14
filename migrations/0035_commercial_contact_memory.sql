-- Historial único de contactos comerciales iniciados por automatizaciones.
-- Los estados históricos desconocidos no se migran como entregados.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS marketing_opt_out BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS saludo_pendiente_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS commercial_contact_events (
    id BIGSERIAL PRIMARY KEY,
    phone VARCHAR(40) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source VARCHAR(60) NOT NULL,
    reason VARCHAR(120) NOT NULL,
    strategy VARCHAR(120) NOT NULL,
    content TEXT NOT NULL,
    provider_status VARCHAR(20) NOT NULL CHECK (provider_status IN ('SENDING','SENT','FAILED','UNKNOWN')),
    response_status VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN' CHECK (response_status IN ('UNKNOWN','REPLIED','NO_REPLY','DECLINED')),
    operation_id INTEGER REFERENCES operations(id) ON DELETE SET NULL,
    provider_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_commercial_contact_phone_date
    ON commercial_contact_events (phone, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_commercial_contact_active_claim
    ON commercial_contact_events (phone) WHERE provider_status = 'SENDING';
