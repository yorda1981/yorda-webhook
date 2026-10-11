-- Motor de Selección de Contenido — metadatos objetivos mínimos.
-- No publica, no programa y no registra una selección como utilización.

ALTER TABLE content_items
    ADD COLUMN IF NOT EXISTS estado VARCHAR(12) NOT NULL DEFAULT 'ACTIVO',
    ADD COLUMN IF NOT EXISTS idioma VARCHAR(2) NOT NULL DEFAULT 'es',
    ADD COLUMN IF NOT EXISTS prioridad SMALLINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ultima_utilizacion_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'content_items_estado_check'
          AND conrelid = 'content_items'::regclass
    ) THEN
        ALTER TABLE content_items ADD CONSTRAINT content_items_estado_check
            CHECK (estado IN ('ACTIVO', 'INACTIVO'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'content_items_idioma_check'
          AND conrelid = 'content_items'::regclass
    ) THEN
        ALTER TABLE content_items ADD CONSTRAINT content_items_idioma_check
            CHECK (idioma IN ('es', 'pt'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'content_items_prioridad_check'
          AND conrelid = 'content_items'::regclass
    ) THEN
        ALTER TABLE content_items ADD CONSTRAINT content_items_prioridad_check
            CHECK (prioridad BETWEEN 0 AND 100);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_content_items_selection
    ON content_items (idioma, prioridad DESC, ultima_utilizacion_at ASC, id ASC)
    WHERE estado = 'ACTIVO';
