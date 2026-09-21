-- 0016_entregas_avisos_automaticos.sql
--
-- Avisos automáticos de "tu entrega sigue pendiente" para clientes con una
-- entrega de efectivo en curso (ver src/services/entregas-avisos.js).
-- Pertenece EXCLUSIVAMENTE al CRM de Entregas ya existente -- no crea un
-- segundo sistema de estados, reutiliza estado_entrega='PENDIENTE' tal
-- como ya existe (migración 0005) y el mismo patrón de columna-gate por
-- franja horaria que ya usa `ultimo_aviso_atraso` (mismo archivo,
-- mismo tipo TIMESTAMP sin zona horaria -- se mantiene el mismo tipo por
-- consistencia dentro de esta tabla; la comparación la hace la capa de
-- aplicación con src/utils/timezone.js:inicioDiaSaoPauloUTC(), nunca
-- comparando strings).
--
-- avisos_automaticos: control ON/OFF individual por entrega (sección L).
-- Default TRUE -- mismo criterio que el resto del sistema: la
-- automatización está activa por defecto y se apaga caso por caso (igual
-- que blocked_numbers es una lista de EXCEPCIONES, no una lista de
-- permitidos), consistente con que YordaBot ya envía avisos proactivos
-- (recordatorios CRM, aviso VIP, aviso de entrega atrasada al admin) sin
-- que el operador tenga que habilitarlos manualmente uno por uno.
--
-- ultimo_aviso_manana_at / ultimo_aviso_tarde_at: gate por franja, igual
-- patrón que ultimo_aviso_atraso -- nunca más de un aviso por franja por
-- día de calendario (Brasil). No es una ventana deslizante de horas.
--
-- ultimo_aviso_plantilla_idx: índice (0-based) de la última plantilla de
-- mensaje usada (mañana o tarde, lo que se haya mandado más reciente),
-- para que la siguiente NO repita la misma plantilla consecutivamente
-- (sección J/Q) cuando haya más de una disponible.

ALTER TABLE entregas ADD COLUMN IF NOT EXISTS avisos_automaticos BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE entregas ADD COLUMN IF NOT EXISTS ultimo_aviso_manana_at TIMESTAMP;
ALTER TABLE entregas ADD COLUMN IF NOT EXISTS ultimo_aviso_tarde_at TIMESTAMP;
ALTER TABLE entregas ADD COLUMN IF NOT EXISTS ultimo_aviso_plantilla_idx SMALLINT;
