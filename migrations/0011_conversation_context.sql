-- 0011_conversation_context.sql
--
-- Contexto conversacional corto (última pregunta del bot + últimas
-- opciones mostradas), para poder interpretar respuestas breves como
-- "la primera"/"esa"/"tarjeta" sin ambigüedad. Persistido en Postgres a
-- propósito (no en memoria del proceso) — Railway puede reiniciar el
-- servicio en cualquier momento, y este contexto debe sobrevivir eso
-- igual que el resto del estado de negocio en `customers`.
--
-- `contexto_actualizado_at` es la base del TTL corto de este contexto
-- (ver CONTEXTO_CORTO_TTL_MS en src/services/reglas-bot.js) — es una
-- ventana DISTINTA e independiente de las 2 horas de
-- `aguardando_comprovante`/DOS_HORAS, nunca se mezclan.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS ultima_pregunta VARCHAR(40);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ultimas_opciones JSONB;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS contexto_actualizado_at TIMESTAMPTZ;
