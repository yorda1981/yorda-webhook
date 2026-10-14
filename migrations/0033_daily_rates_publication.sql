-- Publicación diaria automática de las tasas del destino activo.
-- Reutiliza el scheduler y el historial de publicaciones del Content Center.
ALTER TABLE content_destinations
    ADD COLUMN IF NOT EXISTS tasas_habilitadas BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS tasas_hora TIME NOT NULL DEFAULT '09:00';

ALTER TABLE content_items
    ADD COLUMN IF NOT EXISTS origen_sistema VARCHAR(40);

CREATE UNIQUE INDEX IF NOT EXISTS uq_content_items_origen_sistema
    ON content_items (origen_sistema)
    WHERE origen_sistema IS NOT NULL;
