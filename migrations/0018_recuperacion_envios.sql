-- FASE 2: historial e idempotencia de recuperaciones manuales.
-- No toca customers, operations ni cambia ningún estado financiero.
CREATE TABLE IF NOT EXISTS recuperacion_envios (
    id                  BIGSERIAL PRIMARY KEY,
    phone               VARCHAR(40) NOT NULL,
    familia             VARCHAR(40) NOT NULL,
    variante_indice     INTEGER NOT NULL,
    tono                VARCHAR(20),
    tipo_favorito       VARCHAR(40),
    texto               TEXT NOT NULL,
    estado              VARCHAR(20) NOT NULL CHECK (estado IN ('ENVIANDO','ENVIADO','FALLIDO','EXPIRADO')),
    idempotency_key     VARCHAR(120) NOT NULL UNIQUE,
    error               TEXT,
    creado_at           TIMESTAMP NOT NULL DEFAULT NOW(),
    enviado_at          TIMESTAMP,
    actualizado_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recuperacion_envios_phone_fecha
    ON recuperacion_envios (phone, creado_at DESC);

-- Impide dos intentos simultáneos o dos éxitos concurrentes para el mismo
-- cliente. Los éxitos se pasan a EXPIRADO al intentar otro envío después del
-- cooldown, conservando siempre el historial.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recuperacion_envios_phone_activo
    ON recuperacion_envios (phone)
    WHERE estado IN ('ENVIANDO','ENVIADO');
