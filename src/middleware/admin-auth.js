"use strict";

const authAttempt = require("./auth-attempt-limiter");

const MENSAJE_BLOQUEO = { error: "Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo." };

function verificarToken(req, res, next) {
    if (authAttempt.bloqueado(req.ip)) {
        return res.status(429).json(MENSAJE_BLOQUEO);
    }
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const secret = process.env.ADMIN_TOKEN?.trim();
    if (!token || token.trim() !== secret) {
        authAttempt.registrarFallo(req.ip);
        return res.status(401).json({ error: "No autorizado" });
    }
    authAttempt.registrarExito(req.ip);
    next();
}

// Acceso separado y más limitado: solo para las rutas del CRM de Entregas
// (/admin/entregas...). Pensado para dar acceso a otra persona (ej. quien
// coordina las entregas en Cuba) sin exponerle tasas, VIP ni ofertas.
// El token de admin normal también sigue funcionando aquí.
function verificarTokenEntregas(req, res, next) {
    if (authAttempt.bloqueado(req.ip)) {
        return res.status(429).json(MENSAJE_BLOQUEO);
    }
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const secretAdmin    = process.env.ADMIN_TOKEN?.trim();
    const secretEntregas = process.env.ENTREGAS_TOKEN?.trim();
    const valido = token && (token === secretAdmin || (secretEntregas && token === secretEntregas));
    if (!valido) {
        authAttempt.registrarFallo(req.ip);
        return res.status(401).json({ error: "No autorizado" });
    }
    authAttempt.registrarExito(req.ip);
    next();
}

module.exports = { verificarToken, verificarTokenEntregas };
