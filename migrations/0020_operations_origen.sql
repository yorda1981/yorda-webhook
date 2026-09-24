-- Origen interno de la operación. NULL = flujos existentes (WhatsApp/
-- calculadora); 'dashboard_manual' = alta manual de transferencias desde el
-- dashboard. Solo identifica el origen: no excluye la operación de ninguna
-- estadística ni cambia su circuito (pendiente -> confirmada -> completada).
ALTER TABLE operations
    ADD COLUMN IF NOT EXISTS origen VARCHAR(30);
