-- Content Center V1 — núcleo persistente.
--
-- Esta migración crea únicamente el modelo base aprobado. No registra rutas,
-- no programa jobs y no envía mensajes. Contenido, revisión, publicación e
-- intento tienen identidades separadas para conservar el historial exacto.

CREATE TABLE IF NOT EXISTS content_items (
    id          BIGSERIAL PRIMARY KEY,
    titulo      VARCHAR(160) NOT NULL CHECK (NULLIF(BTRIM(titulo), '') IS NOT NULL),
    creado_por  VARCHAR(40) NOT NULL DEFAULT 'admin',
    creado_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS content_revisions (
    id              BIGSERIAL PRIMARY KEY,
    content_item_id BIGINT NOT NULL REFERENCES content_items(id),
    numero          INTEGER NOT NULL CHECK (numero > 0),
    cuerpo          TEXT NOT NULL CHECK (NULLIF(BTRIM(cuerpo), '') IS NOT NULL),
    creado_por      VARCHAR(40) NOT NULL DEFAULT 'admin',
    creado_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (content_item_id, numero),
    UNIQUE (id, content_item_id)
);

CREATE INDEX IF NOT EXISTS idx_content_revisions_item_fecha
    ON content_revisions (content_item_id, creado_at DESC);

CREATE TABLE IF NOT EXISTS content_publications (
    id                  BIGSERIAL PRIMARY KEY,
    content_item_id     BIGINT NOT NULL REFERENCES content_items(id),
    revision_id         BIGINT NOT NULL,
    canal               VARCHAR(40) NOT NULL DEFAULT 'whatsapp_admin',
    destino_ref         VARCHAR(120) NOT NULL DEFAULT 'ADMIN_PHONE',
    cuerpo_renderizado  TEXT NOT NULL CHECK (NULLIF(BTRIM(cuerpo_renderizado), '') IS NOT NULL),
    estado              VARCHAR(24) NOT NULL CHECK (estado IN (
                            'PROGRAMADA', 'PUBLICANDO', 'PUBLICADA',
                            'FALLIDA', 'AMBIGUA', 'CANCELADA'
                        )),
    idempotency_key     VARCHAR(160) NOT NULL UNIQUE,
    programada_para     TIMESTAMPTZ NOT NULL,
    iniciada_at         TIMESTAMPTZ,
    publicada_at        TIMESTAMPTZ,
    cancelada_at        TIMESTAMPTZ,
    external_id         VARCHAR(200),
    error               TEXT,
    origen              VARCHAR(40) NOT NULL DEFAULT 'admin',
    creado_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (revision_id, content_item_id)
        REFERENCES content_revisions(id, content_item_id)
);

CREATE INDEX IF NOT EXISTS idx_content_publications_due
    ON content_publications (programada_para, id)
    WHERE estado = 'PROGRAMADA';

CREATE INDEX IF NOT EXISTS idx_content_publications_item_fecha
    ON content_publications (content_item_id, creado_at DESC);

CREATE TABLE IF NOT EXISTS content_publication_attempts (
    id                  BIGSERIAL PRIMARY KEY,
    publication_id      BIGINT NOT NULL REFERENCES content_publications(id),
    numero              INTEGER NOT NULL CHECK (numero > 0),
    estado              VARCHAR(20) NOT NULL CHECK (estado IN (
                            'INICIADO', 'ENVIADO', 'FALLIDO', 'AMBIGUO'
                        )),
    external_id         VARCHAR(200),
    error               TEXT,
    iniciado_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finalizado_at       TIMESTAMPTZ,
    UNIQUE (publication_id, numero)
);

CREATE INDEX IF NOT EXISTS idx_content_publication_attempts_publication
    ON content_publication_attempts (publication_id, numero DESC);

-- Historial append-only. `datos` queda reservado para metadatos técnicos
-- pequeños y versionados; estados y relaciones principales siempre viven en
-- columnas explícitas de sus tablas correspondientes.
CREATE TABLE IF NOT EXISTS content_events (
    id              BIGSERIAL PRIMARY KEY,
    entity_type     VARCHAR(30) NOT NULL CHECK (entity_type IN (
                        'CONTENT_ITEM', 'REVISION', 'PUBLICATION', 'ATTEMPT'
                    )),
    entity_id       BIGINT NOT NULL,
    event_type      VARCHAR(60) NOT NULL CHECK (NULLIF(BTRIM(event_type), '') IS NOT NULL),
    actor           VARCHAR(40) NOT NULL DEFAULT 'system',
    datos           JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(datos) = 'object'),
    ocurrido_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_events_entity_fecha
    ON content_events (entity_type, entity_id, ocurrido_at, id);
