-- Primer paquete de ejecución del Director: recuperación de abandonos.
-- Solo prepara material para revisión; nunca envía mensajes automáticamente.
CREATE TABLE IF NOT EXISTS director_execution_packages (
    id              BIGSERIAL PRIMARY KEY,
    decision_id     BIGINT NOT NULL UNIQUE REFERENCES director_decisions(id),
    tipo            VARCHAR(40) NOT NULL CHECK (tipo = 'RECUPERACION_ABANDONOS'),
    estado          VARCHAR(12) NOT NULL DEFAULT 'BORRADOR'
                    CHECK (estado IN ('BORRADOR', 'APROBADO', 'CANCELADO')),
    contenido       JSONB NOT NULL CHECK (jsonb_typeof(contenido) = 'object'),
    creado_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resuelto_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_director_execution_packages_estado
    ON director_execution_packages (estado, actualizado_at DESC);
