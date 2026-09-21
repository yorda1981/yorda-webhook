-- 0002_efectivo_y_pedidos_web.sql
-- Copiado literal de index.js (bloque "Migración segura: columna de tasa
-- para envío de efectivo" + "Datos de pedidos de entrega generados desde
-- la calculadora web"). Mismo orden histórico.

ALTER TABLE rates ADD COLUMN IF NOT EXISTS efectivo NUMERIC DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS saludo_pendiente BOOLEAN DEFAULT false;
ALTER TABLE rates ADD COLUMN IF NOT EXISTS tarifa_entrega NUMERIC DEFAULT 0;

ALTER TABLE operations
    ADD COLUMN IF NOT EXISTS ref_web VARCHAR(20),
    ADD COLUMN IF NOT EXISTS direccion TEXT,
    ADD COLUMN IF NOT EXISTS provincia VARCHAR(60),
    ADD COLUMN IF NOT EXISTS municipio VARCHAR(60),
    ADD COLUMN IF NOT EXISTS referencia_entrega TEXT,
    ADD COLUMN IF NOT EXISTS telefono_entrega VARCHAR(30),
    ADD COLUMN IF NOT EXISTS entrega_disponible BOOLEAN,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
