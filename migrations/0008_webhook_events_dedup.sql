-- 0008_webhook_events_dedup.sql
--
-- Fase 6 — deduplicación de messageId persistida en Postgres. Reemplaza
-- la fuente de verdad del Set en memoria (que se pierde al reiniciar y no
-- se comparte entre instancias) por esta tabla. El Set en memoria se
-- conserva como filtro rápido de primera línea (evita una consulta a la
-- DB en el caso común), pero la tabla es la que realmente decide.
--
-- INSERT ... ON CONFLICT DO NOTHING RETURNING es atómico: si dos
-- instancias reciben el mismo webhook reintentado al mismo tiempo, solo
-- una consigue insertar la fila (por eso PRIMARY KEY en message_id), la
-- otra ve 0 filas devueltas y sabe que ya fue procesado.

CREATE TABLE IF NOT EXISTS webhook_events (
    message_id  TEXT PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Para el job de limpieza (borra eventos viejos, ver src/services/webhook-guard.js).
CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at ON webhook_events(received_at);
