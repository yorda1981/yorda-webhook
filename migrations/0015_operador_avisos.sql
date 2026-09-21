-- 0015_operador_avisos.sql
--
-- Trazabilidad + idempotencia del aviso de "nueva transferencia" que
-- reciben los Operadores de Transferencias (ver src/services/operadores.js).
--
-- Un mismo par (operador, operación) NUNCA puede avisarse dos veces -- el
-- UNIQUE es la garantía atómica: la inserción es un
-- "INSERT ... ON CONFLICT (operador_id, operation_id) DO NOTHING RETURNING id"
-- (mismo patrón ya usado en blocked_numbers.bloquear() y en el índice único
-- parcial de comprobante_e2e, migración 0012). Si la fila NO se insertó
-- (ya existía), significa que ya se avisó -- un retry de webhook, una
-- recarga de página o una repetición del proceso de confirmación jamás
-- puede volver a mandar el mismo aviso al mismo trabajador.
--
-- No se borra nunca (no es historial financiero, pero registra quién y
-- cuándo se avisó -- se conserva para poder responder después "¿a quién
-- se avisó la operación X y cuándo?").

CREATE TABLE IF NOT EXISTS operador_avisos (
    id           SERIAL PRIMARY KEY,
    operador_id  INTEGER NOT NULL REFERENCES operadores(id),
    operation_id INTEGER NOT NULL REFERENCES operations(id),
    enviado_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (operador_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_operador_avisos_operation ON operador_avisos(operation_id);
