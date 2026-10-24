-- Marketer automático integrado al Director y la Biblioteca existentes.
-- Se despliega desactivado; el propietario debe habilitarlo desde el panel.
ALTER TABLE director_config
    ADD COLUMN IF NOT EXISTS marketer_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS marketer_categories JSONB NOT NULL DEFAULT '["como-utilizar-yorda","captacion","referidos","preguntas-frecuentes","confianza","opciones-recepcion"]'::jsonb,
    ADD COLUMN IF NOT EXISTS marketer_time TIME NOT NULL DEFAULT TIME '18:00';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'director_config_marketer_categories_check'
          AND conrelid = 'director_config'::regclass
    ) THEN
        ALTER TABLE director_config ADD CONSTRAINT director_config_marketer_categories_check
            CHECK (jsonb_typeof(marketer_categories) = 'array');
    END IF;
END $$;

ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_grupo_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_grupo_check
    CHECK (grupo IS NULL OR grupo IN ('actualidad', 'permanente', 'comercial'));
