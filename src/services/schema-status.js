"use strict";

// ─────────────────────────────────────────────────────────
// ESTADO DEL ESQUEMA VERSIONADO
//
// Compara migrations/*.sql con schema_migrations. Solo lee: aplicar
// migraciones es responsabilidad exclusiva de scripts/migrate.js, que
// Railway ejecuta como pre-deploy (railway.json).
//
// createSchemaGate retiene los servicios que dependen del esquema hasta
// que no quede ninguna migración pendiente. Mientras tanto vuelve a
// comprobar cada intervalo y registra cada estado una sola vez.
// ─────────────────────────────────────────────────────────

const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");
// Clave fija de pg_advisory_lock compartida por todas las ejecuciones del migrador.
// Clave nueva: la anterior quedó retenida como lock de sesión en el pooler
// de Neon por versiones previas del runner; las nuevas migraciones usan
// exclusivamente pg_advisory_xact_lock y no dejan locks huérfanos.
const MIGRATION_LOCK_KEY = "7204202610140033";
const SCHEMA_CHECK_INTERVAL_MS = 30 * 1000;
const UNDEFINED_TABLE = "42P01";

const SCHEMA_STATES = Object.freeze({
    VERIFICANDO: "VERIFICANDO",
    COMPLETO: "COMPLETO",
    PENDIENTE: "PENDIENTE",
    NO_VERIFICADO: "NO_VERIFICADO"
});

function listMigrationFiles(dir = MIGRATIONS_DIR) {
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort(); // 0001_, 0002_, ... orden lexicográfico = orden de aplicación
}

async function getPendingMigrations(db, files = listMigrationFiles()) {
    let rows;
    try {
        ({ rows } = await db.query("SELECT name FROM schema_migrations"));
    } catch (e) {
        if (e.code === UNDEFINED_TABLE) return [...files];
        throw e;
    }
    const aplicadas = new Set(rows.map((r) => r.name));
    return files.filter((f) => !aplicadas.has(f));
}

function createSchemaGate({
    db,
    start,
    files,
    intervalMs = SCHEMA_CHECK_INTERVAL_MS,
    logError = (message) => console.error(message)
}) {
    let status = { estado: SCHEMA_STATES.VERIFICANDO, pendientes: [] };
    let lastMessage = null;
    let timer = null;
    let checking = false;

    function report(message) {
        if (message === lastMessage) return;
        lastMessage = message;
        logError(message);
    }

    async function check() {
        if (checking || status.estado === SCHEMA_STATES.COMPLETO) return status;
        checking = true;
        try {
            const pendientes = await getPendingMigrations(db, files || listMigrationFiles());
            if (pendientes.length === 0) {
                status = { estado: SCHEMA_STATES.COMPLETO, pendientes: [] };
                if (timer) clearInterval(timer);
                timer = null;
            } else {
                status = { estado: SCHEMA_STATES.PENDIENTE, pendientes };
                report(`❌ SCHEMA_PENDING: faltan ${pendientes.length} migraciones (${pendientes.join(", ")}). Servicios dependientes del esquema detenidos hasta ejecutar node scripts/migrate.js.`);
            }
        } catch (e) {
            status = { estado: SCHEMA_STATES.NO_VERIFICADO, pendientes: [] };
            report(`❌ SCHEMA_CHECK_FAILED: no se pudo verificar el esquema (${e.message}). Servicios dependientes del esquema detenidos.`);
        } finally {
            checking = false;
        }
        // Fuera del try: un fallo al arrancar el servicio no es un fallo de esquema.
        if (status.estado === SCHEMA_STATES.COMPLETO) start();
        return status;
    }

    return {
        begin() {
            const ready = check();
            if (status.estado !== SCHEMA_STATES.COMPLETO) {
                timer = setInterval(check, intervalMs);
                if (typeof timer.unref === "function") timer.unref();
            }
            return ready;
        },
        check,
        getStatus: () => ({ ...status, pendientes: [...status.pendientes] }),
        stop() { if (timer) clearInterval(timer); timer = null; }
    };
}

module.exports = {
    MIGRATIONS_DIR,
    MIGRATION_LOCK_KEY,
    SCHEMA_CHECK_INTERVAL_MS,
    SCHEMA_STATES,
    listMigrationFiles,
    getPendingMigrations,
    createSchemaGate
};
