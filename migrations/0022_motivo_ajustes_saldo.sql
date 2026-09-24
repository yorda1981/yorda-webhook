-- Motivo auditable para correcciones manuales de saldo.
-- Nullable para conservar sin reescritura todos los movimientos históricos.

ALTER TABLE operador_movimientos
    ADD COLUMN IF NOT EXISTS motivo TEXT;

-- Se exige en ajustes nuevos sin invalidar posibles filas históricas creadas
-- antes de que existiera la columna.
ALTER TABLE operador_movimientos
    ADD CONSTRAINT operador_movimientos_ajuste_motivo_check
    CHECK (tipo <> 'ajuste' OR NULLIF(BTRIM(motivo), '') IS NOT NULL)
    NOT VALID;
