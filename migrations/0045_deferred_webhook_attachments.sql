-- Conserva adjuntos recibidos durante la pausa humana para recuperarlos
-- después, sin responder mientras la pausa siga activa. No altera eventos
-- históricos ni los datos financieros.
ALTER TABLE webhook_events
    ADD COLUMN IF NOT EXISTS media_phone TEXT,
    ADD COLUMN IF NOT EXISTS media_payload JSONB,
    ADD COLUMN IF NOT EXISTS media_status TEXT,
    ADD COLUMN IF NOT EXISTS media_not_before TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_webhook_events_deferred_media
    ON webhook_events (media_not_before, received_at)
    WHERE media_status = 'DEFERRED';
