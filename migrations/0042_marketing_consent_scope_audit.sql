-- Explicita alcance y evidencia temporal del consentimiento comercial.
-- Los registros históricos permanecen con alcance NULL: no se infiere retroactivamente.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS marketing_consent_scope TEXT,
    ADD COLUMN IF NOT EXISTS marketing_consent_revoked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS marketing_consent_revoked_source TEXT,
    ADD COLUMN IF NOT EXISTS marketing_consent_revoked_message_id TEXT;
