-- 0014_operadores_transferencias.sql
--
-- Registro de trabajadores que ejecutan Transferencias (CUP/USD/MLC) --
-- EXCLUSIVAMENTE Transferencias. Recargas y Entregas de efectivo tienen
-- sus propios módulos (Operaciones de Recargas / CRM de Entregas) y NO
-- pasan por aquí.
--
-- `modalidades` es un array JSON de strings tomados de un conjunto fijo y
-- cerrado: "cup" | "usd" | "mlc" | "todos" (ver
-- src/services/operadores.js:MODALIDADES_VALIDAS). "todos" es un valor
-- especial que habilita las 3 modalidades reales sin tener que listarlas.
-- Se valida en la capa de aplicación (no hay CHECK a nivel SQL) porque
-- Postgres no puede validar el contenido de un array JSONB con un CHECK
-- simple sin una función auxiliar -- mismo criterio que `ultimas_opciones`
-- en customers (migración 0011), que tampoco lleva CHECK.
--
-- Un operador se conserva registrado aunque esté inactivo (activo=false)
-- -- nunca se borra al desactivar, solo dejar de recibir avisos.

CREATE TABLE IF NOT EXISTS operadores (
    id          SERIAL PRIMARY KEY,
    nombre      VARCHAR(100) NOT NULL,
    telefono    VARCHAR(30) NOT NULL,
    activo      BOOLEAN NOT NULL DEFAULT true,
    modalidades JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operadores_activo ON operadores(activo);
