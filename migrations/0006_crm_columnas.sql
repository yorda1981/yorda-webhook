-- 0006_crm_columnas.sql
-- Copiado de src/services/crm.js -> migrarColumnasCRM(). El backfill de
-- datos se deja tal cual (mismo comportamiento, solo se corre una vez por
-- fila gracias al WHERE estado_crm IS NULL).

ALTER TABLE customers ADD COLUMN IF NOT EXISTS estado_crm VARCHAR(40) DEFAULT 'nuevo_cliente';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS idioma VARCHAR(2) DEFAULT 'es';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cliente_frecuente BOOLEAN DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ultimo_recordatorio TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tipo_ultimo_recordatorio VARCHAR(20);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS fecha_cotizacion TIMESTAMPTZ;

UPDATE customers
SET estado_crm = 'completado'
WHERE estado_crm IS NULL
  AND phone IN (
      SELECT DISTINCT phone FROM operations WHERE status IN ('confirmada','completada')
  );

UPDATE customers
SET estado_crm = 'nuevo_cliente'
WHERE estado_crm IS NULL;
