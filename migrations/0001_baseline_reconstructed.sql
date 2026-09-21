-- 0001_baseline_reconstructed.sql
--
-- IMPORTANTE: esto NO es la definición original de estas 5 tablas. No
-- existe ningún CREATE TABLE de customers/operations/rates/ofertas/recargas
-- en ningún commit de este repositorio — ver docs/database-schema.md,
-- sección "Hallazgo importante". Ya existen en producción (Neon), creadas
-- fuera de este código.
--
-- Esta migración es una RECONSTRUCCIÓN best-effort, pensada para poder
-- levantar una base local/de test desde cero. Nunca reduce, nunca borra,
-- nunca renombra — solo crea si falta.
--
-- DISEÑO A PROPÓSITO: cada columna va en su propio ALTER ... ADD COLUMN
-- IF NOT EXISTS, en vez de un único CREATE TABLE con todas las columnas.
-- Un CREATE TABLE IF NOT EXISTS es un no-op TOTAL si la tabla ya existe
-- (Postgres no compara columnas, solo existencia) — probado en este mismo
-- bloque contra una base "legacy" simulada con un `rates` parcial: el
-- CREATE TABLE completo no agregó las columnas faltantes. Con ALTER
-- columna por columna, cada una se agrega sin importar qué tan parcial
-- sea el estado real de producción, que nunca asumimos igual a DEV.

CREATE TABLE IF NOT EXISTS customers (phone VARCHAR(30) PRIMARY KEY);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS nombre TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ultimo_monto NUMERIC;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tipo_favorito VARCHAR(40);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS banco_favorito VARCHAR(40);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tarjeta_frecuente VARCHAR(20);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS titular_frecuente TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS banco_detectado VARCHAR(40);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS estado VARCHAR(60);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS fecha_estado TIMESTAMP;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS fecha_cotizacion TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS fecha_pix TIMESTAMP;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tarjetas JSONB;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS comprobante_pendiente BOOLEAN;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS valor_comprobante NUMERIC;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ultima_interaccion TIMESTAMP;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS saludo_enviado BOOLEAN;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_response_id VARCHAR(80);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS operations (id SERIAL PRIMARY KEY);
ALTER TABLE operations ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
ALTER TABLE operations ADD COLUMN IF NOT EXISTS nombre TEXT;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS monto NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS cup NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS tarjeta VARCHAR(20);
ALTER TABLE operations ADD COLUMN IF NOT EXISTS titular TEXT;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS banco VARCHAR(40);
ALTER TABLE operations ADD COLUMN IF NOT EXISTS tipo VARCHAR(40) NOT NULL DEFAULT 'brl_cup';
ALTER TABLE operations ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pendiente';
ALTER TABLE operations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
ALTER TABLE operations ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS rates (id INTEGER PRIMARY KEY DEFAULT 1);
ALTER TABLE rates ADD COLUMN IF NOT EXISTS brl_0 NUMERIC;
ALTER TABLE rates ADD COLUMN IF NOT EXISTS brl_100 NUMERIC;
ALTER TABLE rates ADD COLUMN IF NOT EXISTS brl_500 NUMERIC;
ALTER TABLE rates ADD COLUMN IF NOT EXISTS brl_1000 NUMERIC;
ALTER TABLE rates ADD COLUMN IF NOT EXISTS usd1 NUMERIC;
ALTER TABLE rates ADD COLUMN IF NOT EXISTS usd2 NUMERIC;
ALTER TABLE rates ADD COLUMN IF NOT EXISTS mlc NUMERIC;
ALTER TABLE rates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
INSERT INTO rates (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ofertas (id INTEGER PRIMARY KEY DEFAULT 1);
ALTER TABLE ofertas ADD COLUMN IF NOT EXISTS texto TEXT;
ALTER TABLE ofertas ADD COLUMN IF NOT EXISTS activa BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ofertas ADD COLUMN IF NOT EXISTS vence_at TIMESTAMP;
ALTER TABLE ofertas ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
INSERT INTO ofertas (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS recargas (tipo VARCHAR(20) PRIMARY KEY);
ALTER TABLE recargas ADD COLUMN IF NOT EXISTS precio NUMERIC;
ALTER TABLE recargas ADD COLUMN IF NOT EXISTS descripcion TEXT;
ALTER TABLE recargas ADD COLUMN IF NOT EXISTS activa BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE recargas ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
