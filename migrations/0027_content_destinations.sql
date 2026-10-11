-- Destinos reutilizables del Motor de Marketing.

CREATE TABLE IF NOT EXISTS content_destinations (
    id              BIGSERIAL PRIMARY KEY,
    tipo            VARCHAR(30) NOT NULL CHECK (tipo IN ('WHATSAPP_GROUP')),
    external_id     VARCHAR(160) NOT NULL CHECK (NULLIF(BTRIM(external_id), '') IS NOT NULL),
    nombre          VARCHAR(160) NOT NULL CHECK (NULLIF(BTRIM(nombre), '') IS NOT NULL),
    activo          BOOLEAN NOT NULL DEFAULT TRUE,
    validado_at     TIMESTAMPTZ NOT NULL,
    creado_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tipo, external_id)
);

ALTER TABLE content_events DROP CONSTRAINT IF EXISTS content_events_entity_type_check;
ALTER TABLE content_events ADD CONSTRAINT content_events_entity_type_check
    CHECK (entity_type IN (
        'CONTENT_ITEM', 'REVISION', 'PUBLICATION', 'ATTEMPT', 'SCHEDULE', 'DESTINATION'
    ));

