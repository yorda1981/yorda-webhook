-- Cancelación de transferencias desde el CRM: la operación nunca se borra,
-- pasa a status 'cancelada' y guarda cuándo y por qué. Nullable para no
-- reescribir las operaciones históricas.

ALTER TABLE operations
    ADD COLUMN IF NOT EXISTS cancelada_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS motivo_cancelacion TEXT;
