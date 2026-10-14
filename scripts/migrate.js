#!/usr/bin/env node
"use strict";

// ─────────────────────────────────────────────────────────
// RUNNER DE MIGRACIONES — Fase 4
//
// Deliberadamente NO se ejecuta al arrancar index.js (a diferencia del
// bloque IIFE que ya existe ahí). En producción lo ejecuta Railway como
// pre-deploy (railway.json): si sale con código ≠ 0, la nueva versión no
// se activa. También se puede correr a mano apuntando a otra base.
//
//   node scripts/migrate.js                 # aplica contra DATABASE_URL
//   node scripts/migrate.js --dry-run        # solo muestra qué faltaría
//
// Requiere DATABASE_URL en el entorno (mismo nombre que ya usa toda la
// app — ver db.js). Nunca la toca ni la valida más allá de conectarse:
// vos decidís si esa URL apunta a tu base local, a un DB de test o a
// producción. Este script, por sí solo, jamás elige producción.
//
// Idempotente: cada archivo de migrations/*.sql corre UNA sola vez,
// registrado en la tabla schema_migrations. Volver a correr el comando
// no repite nada ya aplicado. Los advisory locks son transaccionales: el
// pooler de Neon puede reasignar sesiones y no debe retener locks de sesión.
// ─────────────────────────────────────────────────────────

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const {
    MIGRATIONS_DIR,
    MIGRATION_LOCK_KEY,
    listMigrationFiles,
    getPendingMigrations
} = require("../src/services/schema-status");

async function main() {
    const dryRun = process.argv.includes("--dry-run");
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        console.error("❌ DATABASE_URL no está definida. No se conecta a ningún lado por defecto.");
        process.exit(1);
    }

    const archivos = listMigrationFiles();

    // Mismo criterio que db.js para SSL, salvo que aquí además se detecta
    // una base local (localhost/127.0.0.1/socket unix con host=/...) para
    // poder probar este runner contra Postgres local sin SSL.
    const esLocal = /localhost|127\.0\.0\.1|host=%2F|host=\//.test(connectionString);
    const sslRejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED === "true";
    const client = new Client({
        connectionString,
        ssl: esLocal ? false : { rejectUnauthorized: sslRejectUnauthorized }
    });

    await client.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id SERIAL PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await client.query("COMMIT");

        const pendientes = await getPendingMigrations(client, archivos);

        if (pendientes.length === 0) {
            console.log("✅ Nada pendiente. La base ya tiene todas las migraciones conocidas.");
            return;
        }

        console.log(`📋 Migraciones pendientes (${pendientes.length}): ${pendientes.join(", ")}`);

        if (dryRun) {
            console.log("🔎 --dry-run: no se aplicó nada.");
            return;
        }

        for (const archivo of pendientes) {
            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, archivo), "utf-8");
            console.log(`▶️  Aplicando ${archivo} ...`);
            try {
                await client.query("BEGIN");
                await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
                const yaAplicada = await client.query(
                    "SELECT 1 FROM schema_migrations WHERE name = $1 LIMIT 1",
                    [archivo]
                );
                if (yaAplicada.rows.length) {
                    await client.query("COMMIT");
                    console.log(`   ↪️  ${archivo} ya fue aplicada por otra ejecución`);
                    continue;
                }
                await client.query(sql);
                await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [archivo]);
                await client.query("COMMIT");
                console.log(`   ✅ ${archivo} aplicada`);
            } catch (e) {
                await client.query("ROLLBACK");
                console.error(`   ❌ ${archivo} falló, se hizo ROLLBACK: ${e.message}`);
                throw e;
            }
        }

        console.log("🎉 Migraciones aplicadas correctamente.");
    } finally {
        await client.end();
    }
}

main().catch((e) => {
    console.error("❌ migrate.js falló:", e.message || e.code || String(e));
    process.exit(1);
});
