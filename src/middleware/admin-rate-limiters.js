"use strict";

const rateLimit = require("express-rate-limit");

// ─────────────────────────────────────────
// LÍMITES DE /admin — separados por tipo de tráfico (antes eran uno solo,
// compartido entre TODAS las rutas de lectura y escritura).
//
// El dashboard hace polling automático cada 30s (ver public/dashboard.html,
// refreshData()) y dispara ~9-10 GET en paralelo por ciclo. Con un único
// límite de 60/min compartido, ese polling por sí solo agotaba el
// contador antes de que un admin humano hiciera clic en nada — cualquier
// acción real (confirmar, completar, crear entrega) quedaba bloqueada
// como efecto colateral de las lecturas rutinarias.
//
// Ahora son dos instancias independientes de express-rate-limit, cada una
// con su propio contador por IP — el tráfico de lectura nunca puede
// consumir el presupuesto de escritura, ni viceversa.
// ─────────────────────────────────────────

// Lectura (GET): generoso a propósito — cubre el polling normal incluso
// con varias pestañas abiertas a la vez, pero sigue acotado (no es "sin
// límite"): 300/min = 5 por segundo sostenido, muy por encima del uso
// real del dashboard y muy por debajo de lo que necesitaría un scraper.
const adminReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests"
});

// Escritura (POST): acciones humanas — confirmar, completar, crear/marcar
// entrega, registrar pago, actualizar tasas/oferta/recargas. 30/min (una
// cada 2 segundos sostenido) es más que suficiente para el uso real y
// sigue protegiendo contra un script que dispare la ruta en bucle.
const adminWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests"
});

module.exports = { adminReadLimiter, adminWriteLimiter };
