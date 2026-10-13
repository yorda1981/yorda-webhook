-- Mejor Decisión Disponible: una única prioridad comercial vigente.
CREATE TABLE IF NOT EXISTS director_decisions (
    id                  BIGSERIAL PRIMARY KEY,
    estado              VARCHAR(12) NOT NULL
                        CHECK (estado IN ('VIGENTE', 'SUSTITUIDA', 'EJECUTADA', 'DESCARTADA', 'RETIRADA')),
    decision            TEXT NOT NULL,
    problema            TEXT NOT NULL,
    evidencia           JSONB NOT NULL CHECK (jsonb_typeof(evidencia) = 'array'),
    justificacion       TEXT NOT NULL,
    accion_recomendada  TEXT NOT NULL,
    resultado_esperado  TEXT NOT NULL,
    impacto             SMALLINT NOT NULL CHECK (impacto BETWEEN 0 AND 100),
    confianza           SMALLINT NOT NULL CHECK (confianza BETWEEN 0 AND 100),
    snapshot            JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    sustituye_id        BIGINT REFERENCES director_decisions(id),
    motivo_cambio       VARCHAR(40),
    explicacion_cambio  TEXT,
    creada_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    evaluada_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cerrada_at          TIMESTAMPTZ
);

-- PostgreSQL garantiza que nunca existan dos prioridades principales.
CREATE UNIQUE INDEX IF NOT EXISTS idx_director_decisions_unica_vigente
    ON director_decisions ((estado)) WHERE estado = 'VIGENTE';

CREATE INDEX IF NOT EXISTS idx_director_decisions_recientes
    ON director_decisions (creada_at DESC);
