-- Embudo comercial por cotización. Los registros nuevos son completos y
-- vinculables; no se backfillea el historial aproximado de customers.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS current_quote_id UUID;

CREATE TABLE IF NOT EXISTS commercial_funnel_quotes (
    quote_id UUID PRIMARY KEY,
    phone VARCHAR(40) NOT NULL,
    quote_type VARCHAR(40) NOT NULL,
    amount NUMERIC,
    output_amount NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    pix_requested_at TIMESTAMPTZ,
    pix_provider_accepted_at TIMESTAMPTZ,
    pix_provider_last_status VARCHAR(12) CHECK (pix_provider_last_status IN ('ACCEPTED','PARTIAL','FAILED','UNKNOWN')),
    receipt_received_at TIMESTAMPTZ,
    source VARCHAR(30) NOT NULL DEFAULT 'WHATSAPP'
);

-- La relación se escribe en la misma operación financiera, atómicamente con
-- su creación. Las transiciones posteriores siguen siendo las columnas
-- existentes de operations (confirmed_at/completed_at/cancelada_at/status).
ALTER TABLE operations
    ADD COLUMN IF NOT EXISTS quote_id UUID REFERENCES commercial_funnel_quotes(quote_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_commercial_quote
    ON operations (quote_id) WHERE quote_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commercial_funnel_quotes_cohort
    ON commercial_funnel_quotes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commercial_funnel_quotes_phone
    ON commercial_funnel_quotes (phone, created_at DESC);
