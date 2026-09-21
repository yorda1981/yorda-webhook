-- 0010_blocked_numbers.sql
--
-- Lista administrativa de números bloqueados. Un número bloqueado no
-- recibe NINGUNA automatización de YordaBot (ver src/services/blocked-numbers.js
-- y su uso en index.js) — pero nunca se toca su historial ni sus
-- operaciones, y la intervención manual del operador sigue funcionando.
--
-- Desbloquear = DELETE de la fila (no soft-delete): si se vuelve a
-- bloquear después, es un INSERT nuevo con su propia fecha, sin ambigüedad
-- sobre si "fecha de bloqueo" es la primera vez o la más reciente.

CREATE TABLE IF NOT EXISTS blocked_numbers (
    phone      VARCHAR(30) PRIMARY KEY,
    motivo     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
