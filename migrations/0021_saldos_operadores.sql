-- Saldos independientes y libro auditable para operadores de transferencias.
-- Los saldos parten de cero: las operaciones históricas no se descuentan
-- retroactivamente y deben cargarse antes de completar nuevas transferencias.

ALTER TABLE operadores
    ADD COLUMN IF NOT EXISTS saldo_cup NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (saldo_cup >= 0),
    ADD COLUMN IF NOT EXISTS saldo_usd NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (saldo_usd >= 0),
    ADD COLUMN IF NOT EXISTS saldo_mlc NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (saldo_mlc >= 0);

ALTER TABLE operations
    ADD COLUMN IF NOT EXISTS operador_id INTEGER REFERENCES operadores(id);

CREATE INDEX IF NOT EXISTS idx_operations_operador ON operations(operador_id);

CREATE TABLE IF NOT EXISTS operador_movimientos (
    id             BIGSERIAL PRIMARY KEY,
    operador_id    INTEGER NOT NULL REFERENCES operadores(id),
    moneda         VARCHAR(3) NOT NULL CHECK (moneda IN ('CUP','USD','MLC')),
    monto          NUMERIC(18,2) NOT NULL CHECK (monto <> 0),
    tipo           VARCHAR(10) NOT NULL CHECK (tipo IN ('carga','descuento','reintegro','ajuste')),
    operation_id   INTEGER REFERENCES operations(id),
    saldo_anterior NUMERIC(18,2) NOT NULL CHECK (saldo_anterior >= 0),
    saldo_posterior NUMERIC(18,2) NOT NULL CHECK (saldo_posterior >= 0),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_operador_movimiento_descuento
    ON operador_movimientos(operation_id)
    WHERE tipo = 'descuento';

CREATE UNIQUE INDEX IF NOT EXISTS uq_operador_movimiento_reintegro
    ON operador_movimientos(operation_id)
    WHERE tipo = 'reintegro';

CREATE INDEX IF NOT EXISTS idx_operador_movimientos_recientes
    ON operador_movimientos(operador_id, created_at DESC);
