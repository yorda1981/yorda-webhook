"use strict";

// ─────────────────────────────────────────
// ZONA HORARIA DEL NEGOCIO — America/Sao_Paulo
//
// Sin dependencias externas: usa Intl.DateTimeFormat (nativo de Node) con
// timeZone explícito, así que funciona sin importar en qué zona horaria
// esté corriendo el proceso (Railway suele correr en UTC). El truco es el
// estándar para convertir hacia/desde una IANA timezone sin librería:
// formatear el mismo instante en la zona destino y medir la diferencia.
// ─────────────────────────────────────────

const ZONA_NEGOCIO = "America/Sao_Paulo";

function partesEnZona(fecha, zona) {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: zona,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false
    });
    const partes = {};
    for (const p of formatter.formatToParts(fecha)) partes[p.type] = p.value;
    return partes;
}

// Convierte un string "YYYY-MM-DDTHH:mm" (tal como lo entrega un <input
// type="datetime-local">, SIN zona horaria) interpretándolo como hora
// LOCAL de America/Sao_Paulo, y devuelve el instante UTC real
// correspondiente (Date). Devuelve null si el string es inválido/vacío --
// nunca inventa una fecha.
function saoPauloLocalAUTC(local) {
    if (!local) return null;
    const m = String(local).trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const hh = Number(m[4]), mi = Number(m[5]), ss = m[6] ? Number(m[6]) : 0;

    const comoUTC = Date.UTC(y, mo - 1, d, hh, mi, ss);
    const partes = partesEnZona(new Date(comoUTC), ZONA_NEGOCIO);
    const horaFmt = partes.hour === "24" ? 0 : Number(partes.hour);
    const comoSePresentaEnSaoPaulo = Date.UTC(
        Number(partes.year), Number(partes.month) - 1, Number(partes.day),
        horaFmt, Number(partes.minute), Number(partes.second)
    );
    const desplazamientoMs = comoUTC - comoSePresentaEnSaoPaulo;
    return new Date(comoUTC + desplazamientoMs);
}

// Convierte un instante (Date/ISO string) a un string "YYYY-MM-DDTHH:mm" en
// hora LOCAL de America/Sao_Paulo -- para precargar un <input
// type="datetime-local"> en el dashboard. Devuelve "" si la fecha es
// inválida/vacía.
function utcASaoPauloLocal(fecha) {
    if (!fecha) return "";
    const d = fecha instanceof Date ? fecha : new Date(fecha);
    if (Number.isNaN(d.getTime())) return "";
    const partes = partesEnZona(d, ZONA_NEGOCIO);
    const hora = partes.hour === "24" ? "00" : partes.hour;
    return `${partes.year}-${partes.month}-${partes.day}T${hora}:${partes.minute}`;
}

// Fecha (YYYY-MM-DD) del día calendario ACTUAL en America/Sao_Paulo, para
// un instante dado (por defecto ahora mismo). Es la base para comparar
// "¿ya se mandó el aviso de hoy?" sin depender de la zona horaria del
// proceso (Railway corre en UTC) -- ver avisos de recargas/entregas.
function fechaSaoPaulo(fecha = new Date()) {
    const partes = partesEnZona(fecha, ZONA_NEGOCIO);
    return `${partes.year}-${partes.month}-${partes.day}`;
}

// Instante UTC correspondiente a las 00:00 de HOY en America/Sao_Paulo
// (para un instante dado, por defecto ahora). Se usa para comparar
// "¿el último aviso fue antes de que empezara el día de hoy en Brasil?"
// -- nunca una ventana deslizante de "hace X horas", porque los avisos de
// mañana/tarde son horarios FIJOS del calendario, no relativos.
function inicioDiaSaoPauloUTC(fecha = new Date()) {
    return saoPauloLocalAUTC(`${fechaSaoPaulo(fecha)}T00:00`);
}

module.exports = { ZONA_NEGOCIO, saoPauloLocalAUTC, utcASaoPauloLocal, fechaSaoPaulo, inicioDiaSaoPauloUTC };
