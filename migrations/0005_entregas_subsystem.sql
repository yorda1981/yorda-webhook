-- 0005_entregas_subsystem.sql
-- CRM DE ENTREGAS — copiado literal de index.js. Este bloque SÍ tenía DDL
-- completo en el código (a diferencia de las tablas base), así que es
-- alta confianza, no reconstrucción.

CREATE SEQUENCE IF NOT EXISTS entregas_codigo_seq START WITH 1000;
CREATE SEQUENCE IF NOT EXISTS entregas_pago_codigo_seq START WITH 1;

CREATE TABLE IF NOT EXISTS entregas_pagos (
    id               SERIAL PRIMARY KEY,
    codigo           VARCHAR(20) UNIQUE NOT NULL,
    cantidad_enviada NUMERIC,
    moneda_pago      VARCHAR(20),
    fecha            DATE,
    txid             VARCHAR(150),
    observacion      TEXT,
    created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS entregas (
    id                SERIAL PRIMARY KEY,
    codigo            VARCHAR(20) UNIQUE NOT NULL,
    operation_id      INTEGER REFERENCES operations(id),
    ref_web           VARCHAR(20),
    phone             VARCHAR(30) NOT NULL,
    cliente_nombre    VARCHAR(150),
    telefono_entrega  VARCHAR(30),
    cantidad          NUMERIC NOT NULL,
    moneda            VARCHAR(3) NOT NULL,
    modalidad         VARCHAR(20) NOT NULL DEFAULT 'EFECTIVO',
    provincia         VARCHAR(60),
    municipio         VARCHAR(60),
    direccion         TEXT,
    referencia        TEXT,
    observaciones     TEXT,
    estado_entrega    VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
    fecha_entrega     TIMESTAMP,
    entregado_por     VARCHAR(100),
    estado_pago       VARCHAR(20) NOT NULL DEFAULT 'NO_APLICA',
    pago_id           INTEGER REFERENCES entregas_pagos(id),
    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_entregas_estado_entrega ON entregas(estado_entrega);
CREATE INDEX IF NOT EXISTS idx_entregas_estado_pago ON entregas(estado_pago);
CREATE INDEX IF NOT EXISTS idx_entregas_phone ON entregas(phone);

CREATE TABLE IF NOT EXISTS entregas_historial (
    id          SERIAL PRIMARY KEY,
    entrega_id  INTEGER NOT NULL REFERENCES entregas(id),
    evento      TEXT NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE entregas ADD COLUMN IF NOT EXISTS ultimo_aviso_atraso TIMESTAMP;

CREATE TABLE IF NOT EXISTS entregas_tasas (
    id            INTEGER PRIMARY KEY DEFAULT 1,
    tasa_usdt_cup NUMERIC NOT NULL DEFAULT 0,
    tasa_usdt_usd NUMERIC NOT NULL DEFAULT 0,
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO entregas_tasas (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
