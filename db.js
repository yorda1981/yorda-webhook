const { Pool } = require("pg");

// La mayoría de los proveedores gestionados (Neon, Railway, etc.) usan
// certificados que Node no valida por defecto contra rejectUnauthorized:true,
// así que el valor por defecto se mantiene en false para no romper el
// despliegue actual. Si tu proveedor soporta verificación estricta, configura
// DB_SSL_REJECT_UNAUTHORIZED=true en las variables de entorno para reforzarlo.
const sslRejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED === "true";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: sslRejectUnauthorized
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", (err) => {
  console.error("❌ PostgreSQL Pool Error:", err.message);
});

console.log("✅ PostgreSQL Pool inicializado");

module.exports = pool;
