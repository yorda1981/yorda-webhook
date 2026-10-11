-- Publicación desde la Biblioteca de Contenido.

-- Una programación puede apuntar a un activo concreto. Opcional: sin él se
-- conserva la selección automática por idioma.
ALTER TABLE content_schedules
    ADD COLUMN IF NOT EXISTS content_item_id BIGINT REFERENCES content_items(id);

-- El Motor de Marketing trabaja con un único destino activo, que es el que
-- usan automáticamente todas las publicaciones. Si hubiera varios activos,
-- se conserva el validado más recientemente.
UPDATE content_destinations
SET activo = FALSE, actualizado_at = NOW()
WHERE activo
  AND id <> (
      SELECT id FROM content_destinations
      WHERE activo
      ORDER BY validado_at DESC, id DESC
      LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_content_destinations_single_active
    ON content_destinations ((activo))
    WHERE activo;
