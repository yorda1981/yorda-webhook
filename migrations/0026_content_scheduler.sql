-- Scheduler Persistente de Publicaciones.
-- Solo conserva CUÁNDO invocar al Motor de Publicación y su clave idempotente.

CREATE TABLE IF NOT EXISTS content_schedules (
    id                  BIGSERIAL PRIMARY KEY,
    idioma              VARCHAR(2) NOT NULL CHECK (idioma IN ('es', 'pt')),
    programada_para     TIMESTAMPTZ NOT NULL,
    estado              VARCHAR(20) NOT NULL CHECK (estado IN (
                            'PENDIENTE', 'EJECUTANDO', 'EJECUTADA',
                            'FALLIDA', 'AMBIGUA', 'CANCELADA'
                        )),
    idempotency_key     VARCHAR(160) NOT NULL UNIQUE,
    claimed_at          TIMESTAMPTZ,
    ejecutada_at        TIMESTAMPTZ,
    cancelada_at        TIMESTAMPTZ,
    publication_id      BIGINT REFERENCES content_publications(id),
    result_code         VARCHAR(40),
    error               TEXT,
    creado_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_schedules_due
    ON content_schedules (programada_para, id)
    WHERE estado = 'PENDIENTE';

-- Amplía el historial estructurado existente con la entidad SCHEDULE.
ALTER TABLE content_events
    DROP CONSTRAINT IF EXISTS content_events_entity_type_check;

ALTER TABLE content_events
    ADD CONSTRAINT content_events_entity_type_check CHECK (entity_type IN (
        'CONTENT_ITEM', 'REVISION', 'PUBLICATION', 'ATTEMPT', 'SCHEDULE'
    ));
