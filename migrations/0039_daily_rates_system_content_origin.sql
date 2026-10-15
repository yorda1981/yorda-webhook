-- El activo operacional de tasas es contenido del sistema, no un borrador del
-- operador ni una pieza del Director. Autoriza ese origen explícitamente.
ALTER TABLE content_items
    DROP CONSTRAINT IF EXISTS content_items_origen_check;

ALTER TABLE content_items
    ADD CONSTRAINT content_items_origen_check
    CHECK (origen IN ('operador', 'director', 'system'));
