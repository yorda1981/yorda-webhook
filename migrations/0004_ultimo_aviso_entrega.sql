-- 0004_ultimo_aviso_entrega.sql
-- Copiado literal de index.js.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS ultimo_aviso_entrega TIMESTAMP;
