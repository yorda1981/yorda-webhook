-- Trazabilidad y límites diarios para análisis comerciales con IA.
CREATE TABLE IF NOT EXISTS director_ai_usage (
    id BIGSERIAL PRIMARY KEY,
    analysis_id UUID NOT NULL,
    tarea VARCHAR(40) NOT NULL,
    modelo VARCHAR(120) NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    estimated_tokens INTEGER NOT NULL DEFAULT 0,
    costo_usd NUMERIC(12, 8),
    costo_disponible BOOLEAN NOT NULL DEFAULT FALSE,
    decision_id BIGINT REFERENCES director_decisions(id) ON DELETE SET NULL,
    resultado VARCHAR(20) NOT NULL CHECK (resultado IN ('PENDIENTE','COMPLETADO','BLOQUEADO','ERROR')),
    creado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_director_ai_usage_date
    ON director_ai_usage (creado_at DESC);
CREATE INDEX IF NOT EXISTS idx_director_ai_usage_analysis
    ON director_ai_usage (analysis_id, creado_at);
