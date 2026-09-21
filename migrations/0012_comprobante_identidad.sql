-- 0012_comprobante_identidad.sql
--
-- Extracción estructurada + deduplicación robusta de comprobantes PIX
-- (imagen o PDF, mismo camino -- ver src/services/comprobante-identidad.js
-- y su uso en src/flows/pix-flow.js).
--
-- ESTRATEGIA DE IDENTIDAD (documentada aquí porque las columnas la reflejan):
--   A) EndToEndId (E2E) del PIX -- identificador fuerte, único a nivel de
--      todo el sistema PIX brasileño. Si se pudo leer con confianza,
--      es la clave de deduplicación.
--   B) ID de transacción bancario -- identificador secundario, no
--      garantizado único entre bancos distintos, así que NO lleva
--      constraint UNIQUE (solo índice para búsquedas rápidas).
--   C) Si ninguno de los dos se pudo leer: se sigue usando el fallback
--      existente (monto + ventana de tiempo, en pix-flow.js) SIN CAMBIOS
--      -- monto+teléfono nunca se vuelve una clave de unicidad permanente.
--
-- `comprobante_datos` guarda el resto de los campos extraídos (fecha,
-- hora, pagador, destinatario, destinatario_match, banco_origen) como
-- JSONB en vez de una columna por campo, para no explotar el ancho de la
-- tabla con datos que hoy son informativos/de auditoría, no claves de
-- búsqueda. `comprobante_e2e`/`comprobante_transaccion_id` sí son
-- columnas propias porque SÍ se consultan por igualdad.
--
-- `customers` recibe las mismas 3 columnas como ESTADO DE STAGING: un
-- comprobante puede llegar ANTES de que el cliente complete monto/tarjeta
-- (igual que ya pasa hoy con comprobante_pendiente/valor_comprobante), así
-- que la identidad tiene que sobrevivir hasta que agregarOperacion() la
-- traslade a `operations`. limpiarSesionDB() ya las limpia (ver
-- src/services/customer-memory.js).
--
-- Preparación para conciliación PIX futura (Mercado Pago u otro): el
-- mismo campo comprobante_e2e es el que se comparará contra el E2E que
-- llegue por API/webhook -- por eso se normaliza (mayúsculas, sin
-- espacios) antes de guardarlo, ver normalizarE2E() en
-- src/services/comprobante-identidad.js.

ALTER TABLE operations ADD COLUMN IF NOT EXISTS comprobante_e2e VARCHAR(80);
ALTER TABLE operations ADD COLUMN IF NOT EXISTS comprobante_transaccion_id VARCHAR(80);
ALTER TABLE operations ADD COLUMN IF NOT EXISTS comprobante_datos JSONB;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS comprobante_e2e VARCHAR(80);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS comprobante_transaccion_id VARCHAR(80);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS comprobante_datos JSONB;

-- Índice único PARCIAL (solo cuando no es NULL): dos operaciones con el
-- mismo E2E son, por definición, el mismo pago PIX real -- nunca dos pagos
-- legítimos distintos. Al ser parcial, las filas históricas sin E2E (o
-- cualquier operación futura donde no se pudo leer) nunca chocan entre sí.
CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_comprobante_e2e_unico
    ON operations (comprobante_e2e)
    WHERE comprobante_e2e IS NOT NULL;

-- Índice simple (NO único) para el ID de transacción bancario secundario --
-- acelera la búsqueda, pero sin asumir que es único entre bancos distintos.
CREATE INDEX IF NOT EXISTS idx_operations_comprobante_transaccion_id
    ON operations (comprobante_transaccion_id)
    WHERE comprobante_transaccion_id IS NOT NULL;
