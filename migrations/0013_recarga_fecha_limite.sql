-- 0013_recarga_fecha_limite.sql
--
-- Fecha/hora límite opcional para Recarga Internacional (por ahora
-- exclusivo de esa modalidad -- Nacional sigue sin fecha límite).
--
-- Regla de disponibilidad (calculada al consultar, sin cron/job):
--   activa = true AND (disponible_hasta IS NULL OR disponible_hasta >= NOW())
--
-- TIMESTAMPTZ (no TIMESTAMP): guarda un instante absoluto, sin ambigüedad
-- de zona horaria -- la comparación contra NOW() en Postgres es siempre
-- correcta sin importar en qué zona corra el proceso. La conversión desde
-- "hora local del negocio" (America/Sao_Paulo, tal como la escribe el
-- admin en el dashboard) a este instante absoluto se hace en
-- src/utils/timezone.js (saoPauloLocalAUTC) antes de guardar -- nunca se
-- compara como string.

ALTER TABLE recargas ADD COLUMN IF NOT EXISTS disponible_hasta TIMESTAMPTZ;
