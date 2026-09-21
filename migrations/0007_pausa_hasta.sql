-- 0007_pausa_hasta.sql
--
-- Columna usada por src/services/webhook-guard.js (pausa humana) que NUNCA
-- tuvo un ALTER TABLE en el historial de este repo — ver el "Segundo
-- hallazgo" en docs/database-schema.md. Ya existe en producción (si no,
-- la pausa humana llevaría meses fallando en silencio, cosa que no es el
-- caso). Este archivo solo la deja documentada y reproducible para
-- cualquier base nueva (local/test).

ALTER TABLE customers ADD COLUMN IF NOT EXISTS pausa_hasta TIMESTAMPTZ;
