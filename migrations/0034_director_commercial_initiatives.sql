-- El mismo paquete de ejecución admite iniciativas comerciales transversales;
-- se conserva el tipo legado de recuperación y su contenido sin alteraciones.
ALTER TABLE director_execution_packages
    DROP CONSTRAINT IF EXISTS director_execution_packages_tipo_check;

ALTER TABLE director_execution_packages
    ADD CONSTRAINT director_execution_packages_tipo_check
    CHECK (tipo IN ('RECUPERACION_ABANDONOS', 'INICIATIVA_COMERCIAL'));
