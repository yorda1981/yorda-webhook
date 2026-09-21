-- 0009_idempotency_keys.sql
--
-- Soporte genérico de idempotencia por request-id, primer uso: creación
-- manual de entregas desde el dashboard (src/flows/pedido-web-flow.js,
-- crearEntregaManual). `scope` deja la tabla reutilizable para futuras
-- acciones sin que sus claves puedan chocar entre sí.
--
-- NO se aplicó todavía contra ninguna base (ni local ni producción) —
-- creada y dejada lista, a la espera de pasar por el mismo runner que ya
-- usan 0001-0008 (node scripts/migrate.js) cuando se autorice.

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key         TEXT PRIMARY KEY,
    scope       VARCHAR(60) NOT NULL,
    resource_id INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Para el futuro job de limpieza (mismo patrón que webhook_events, ver
-- 0008) — no se implementa ese job en este bloque, solo se deja el índice.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys(created_at);
