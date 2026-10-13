-- MVP 2 · Director IA: borradores diarios a partir de fuentes verificadas.
-- El Director solo escribe borradores en la Biblioteca; publicar sigue
-- siendo decisión del operador.

-- BORRADOR: el selector automático solo elige ACTIVO, así que un borrador
-- nunca se publica sin que el operador lo apruebe.
ALTER TABLE content_items DROP CONSTRAINT IF EXISTS content_items_estado_check;
ALTER TABLE content_items ADD CONSTRAINT content_items_estado_check
    CHECK (estado IN ('ACTIVO', 'INACTIVO', 'BORRADOR'));

-- grupo: actualidad (depende de las noticias del día) o permanente (guías
-- sobre el proceso real). aporte: cómo ayuda el contenido a generar
-- confianza, clientes o remesas; un borrador del Director sin aporte no existe.
-- impacto: evaluación de impacto comercial con la que el Director lo eligió.
ALTER TABLE content_items
    ADD COLUMN IF NOT EXISTS origen VARCHAR(20) NOT NULL DEFAULT 'operador',
    ADD COLUMN IF NOT EXISTS grupo VARCHAR(12),
    ADD COLUMN IF NOT EXISTS categoria VARCHAR(40),
    ADD COLUMN IF NOT EXISTS aporte TEXT,
    ADD COLUMN IF NOT EXISTS impacto JSONB,
    ADD COLUMN IF NOT EXISTS fuentes JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'content_items_origen_check'
          AND conrelid = 'content_items'::regclass
    ) THEN
        ALTER TABLE content_items ADD CONSTRAINT content_items_origen_check
            CHECK (origen IN ('operador', 'director'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'content_items_grupo_check'
          AND conrelid = 'content_items'::regclass
    ) THEN
        ALTER TABLE content_items ADD CONSTRAINT content_items_grupo_check
            CHECK (grupo IS NULL OR grupo IN ('actualidad', 'permanente'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'content_items_fuentes_check'
          AND conrelid = 'content_items'::regclass
    ) THEN
        ALTER TABLE content_items ADD CONSTRAINT content_items_fuentes_check
            CHECK (jsonb_typeof(fuentes) = 'array');
    END IF;
END $$;

-- Cada ejecución del Director (automática diaria o pedida por el operador).
CREATE TABLE IF NOT EXISTS director_runs (
    id             BIGSERIAL PRIMARY KEY,
    fecha          DATE         NOT NULL,
    disparo        VARCHAR(12)  NOT NULL CHECK (disparo IN ('AUTOMATICO', 'MANUAL')),
    estado         VARCHAR(12)  NOT NULL CHECK (estado IN ('EN_CURSO', 'COMPLETADO', 'FALLIDO')),
    candidatos     INTEGER      NOT NULL DEFAULT 0,
    seleccionados  INTEGER      NOT NULL DEFAULT 0,
    borradores     INTEGER      NOT NULL DEFAULT 0,
    descartados    INTEGER      NOT NULL DEFAULT 0,
    error          TEXT,
    detalle        JSONB        NOT NULL DEFAULT '{}'::jsonb,
    iniciado_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    terminado_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_director_runs_fecha ON director_runs (fecha, id);

-- Cada noticia leída de una fuente se procesa una sola vez (url única).
CREATE TABLE IF NOT EXISTS director_source_items (
    id               BIGSERIAL PRIMARY KEY,
    fuente           VARCHAR(40)  NOT NULL,
    url              TEXT         NOT NULL UNIQUE,
    titulo           TEXT         NOT NULL,
    extracto         TEXT,
    publicado_at     TIMESTAMPTZ,
    capturado_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    run_id           BIGINT       REFERENCES director_runs(id),
    estado           VARCHAR(12)  NOT NULL DEFAULT 'NUEVO'
                     CHECK (estado IN ('NUEVO', 'DESCARTADO', 'USADO', 'ERROR')),
    content_item_id  BIGINT       REFERENCES content_items(id)
);

CREATE INDEX IF NOT EXISTS idx_director_source_items_capturado ON director_source_items (capturado_at);

-- Configuración comercial del Director, versionada: la fila más reciente es
-- la vigente y las anteriores quedan como historial. La mezcla es una
-- propuesta inicial, no una regla: se cambia cuando haya evidencia real de
-- qué contenido genera conversaciones, cotizaciones y remesas.
CREATE TABLE IF NOT EXISTS director_config (
    id                    BIGSERIAL PRIMARY KEY,
    mezcla                JSONB        NOT NULL CHECK (jsonb_typeof(mezcla) = 'object'),
    umbral_impacto        SMALLINT     NOT NULL CHECK (umbral_impacto BETWEEN 0 AND 100),
    max_borradores        SMALLINT     NOT NULL CHECK (max_borradores BETWEEN 1 AND 10),
    ventana_dias          SMALLINT     NOT NULL CHECK (ventana_dias BETWEEN 7 AND 90),
    ajuste_maximo         SMALLINT     NOT NULL CHECK (ajuste_maximo BETWEEN 0 AND 30),
    penalizacion_repeticion SMALLINT   NOT NULL CHECK (penalizacion_repeticion BETWEEN 0 AND 15),
    dias_alerta_sin_borradores SMALLINT NOT NULL CHECK (dias_alerta_sin_borradores BETWEEN 1 AND 30),
    motivo                TEXT         NOT NULL CHECK (NULLIF(BTRIM(motivo), '') IS NOT NULL),
    creado_por            VARCHAR(40)  NOT NULL DEFAULT 'admin',
    creado_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- La mezcla reparte lo publicado entre las tres familias que entiende el
-- servicio y que el operador puede ajustar desde la Biblioteca.
INSERT INTO director_config (mezcla, umbral_impacto, max_borradores, ventana_dias, ajuste_maximo,
                             penalizacion_repeticion, dias_alerta_sin_borradores,
                             motivo, creado_por)
SELECT '{"actualidad": 45, "educacion": 40, "confianza": 15}'::jsonb,
       55, 5, 14, 15, 5, 3,
       'Configuración inicial propuesta sin datos reales. Ajustar con evidencia de conversaciones, cotizaciones y remesas.',
       'sistema'
WHERE NOT EXISTS (SELECT 1 FROM director_config);
