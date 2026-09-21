"use strict";

// ─────────────────────────────────────────────────────────
// AVISOS AUTOMÁTICOS DE ENTREGA PENDIENTE — CRM de Entregas
//
// Mientras una entrega de efectivo siga realmente PENDIENTE (estado real
// del CRM existente, migración 0005 -- nunca se inventa un segundo
// sistema de estados), se le manda al cliente un recordatorio por la
// mañana y otro por la tarde, con una plantilla elegida de un conjunto
// fijo (nunca texto libre generado por IA, nunca promesas que no existan
// en el backend: ni mensajero en camino, ni hora, ni ubicación).
//
// Se detiene automáticamente en cuanto la entrega pasa a ENTREGADO o
// CANCELADO (deja de matchear el filtro `estado_entrega = 'PENDIENTE'`
// de obtenerEntregasPendientesParaAviso), o si se apaga individualmente
// (avisos_automaticos = false, sección L), o si el cliente está
// bloqueado o en pausa humana con un operador (sección O).
// ─────────────────────────────────────────────────────────

const entregasService = require("./entregas");
const blockedNumbers = require("./blocked-numbers");
const { enPausaHumana } = require("./webhook-guard");
const { enviarSeguro } = require("../flows/shared");
const { inicioDiaSaoPauloUTC, fechaSaoPaulo } = require("../utils/timezone");

// Ninguna promesa de mensajero/hora/ubicación -- solo reconoce que sigue
// pendiente y que se le avisará cuando se complete. {nombre} puede venir
// vacío (se omite el saludo con nombre en ese caso, nunca "undefined").
const PLANTILLAS_MANANA = [
    ({ nombre }) => `Buenos días${nombre}😊. Tu entrega todavía está pendiente. Estamos dando seguimiento y te avisaremos apenas sea realizada.`,
    ({ nombre }) => `¡Buen día${nombre}! Pasamos para contarte que tu entrega de efectivo sigue en proceso. En cuanto se complete, te lo confirmamos por aquí.`,
    ({ nombre }) => `Hola${nombre}, buenos días. Seguimos pendientes de tu entrega -- todavía no se ha completado, pero continúa en seguimiento.`
];

const PLANTILLAS_TARDE = [
    ({ nombre }) => `Buenas tardes${nombre}. Pasamos para mantenerte informado: tu entrega continúa pendiente. Te confirmaremos por aquí en cuanto sea realizada.`,
    ({ nombre }) => `Hola${nombre}, seguimos pendientes de tu entrega de efectivo. Aún no se ha completado, pero continúa en seguimiento.`,
    ({ nombre }) => `Buenas tardes${nombre} 😊. Solo para avisarte que tu entrega sigue en curso -- te confirmamos apenas quede realizada.`
];

function plantillasDeFranja(franja) {
    return franja === "manana" ? PLANTILLAS_MANANA : PLANTILLAS_TARDE;
}

// Día del año (1-366) según el calendario de Brasil -- semilla estable
// para variar la plantilla entre días sin depender de Math.random()
// (determinista y testeable: misma entrega + mismo día = misma elección).
function diaDelAnioSaoPaulo(fecha = new Date()) {
    const [anio, mes, dia] = fechaSaoPaulo(fecha).split("-").map(Number);
    const inicioDeAnio = Date.UTC(anio, 0, 1);
    const esteDia = Date.UTC(anio, mes - 1, dia);
    return Math.floor((esteDia - inicioDeAnio) / 86400000) + 1;
}

// Elige un índice de plantilla que NUNCA sea igual al último usado
// (indiceAnterior), cuando hay más de una disponible -- así dos avisos
// consecutivos a la misma entrega (mañana→tarde o tarde→mañana del día
// siguiente) no repiten el mismo texto. `semilla` decide CUÁL de las
// candidatas restantes se usa, de forma determinista y reproducible.
function elegirIndicePlantilla(totalPlantillas, semilla, indiceAnterior) {
    if (totalPlantillas <= 1) return 0;
    const candidatos = [];
    for (let i = 0; i < totalPlantillas; i++) {
        if (i !== indiceAnterior) candidatos.push(i);
    }
    const semillaPositiva = ((semilla % candidatos.length) + candidatos.length) % candidatos.length;
    return candidatos[semillaPositiva];
}

// Arma el mensaje real para una entrega + franja, sin tocar la DB.
// Devuelve { mensaje, indice } -- el índice se persiste luego con
// marcarAvisoEntregaEnviado() para que la próxima vez sepa cuál evitar.
function construirAvisoEntrega(entrega, franja, ahora = new Date()) {
    const plantillas = plantillasDeFranja(franja);
    const semilla = Number(entrega.id || 0) + diaDelAnioSaoPaulo(ahora);
    const indiceAnterior = entrega.ultimo_aviso_plantilla_idx;
    const indice = elegirIndicePlantilla(plantillas.length, semilla, indiceAnterior === null || indiceAnterior === undefined ? -1 : Number(indiceAnterior));

    const primerNombre = entrega.cliente_nombre ? String(entrega.cliente_nombre).trim().split(" ")[0] : "";
    const nombreConEspacio = primerNombre ? `, ${primerNombre}` : "";
    const mensaje = plantillas[indice]({ nombre: nombreConEspacio });
    return { mensaje, indice };
}

// ── Orquestación (llamada por el job en index.js) ──
async function enviarAvisosEntregasPendientes(franja) {
    const inicioDiaUTC = inicioDiaSaoPauloUTC();
    const pendientes = await entregasService.obtenerEntregasPendientesParaAviso(franja, inicioDiaUTC);
    if (!pendientes.length) return { enviados: 0 };

    // Blocklist tiene prioridad absoluta -- igual criterio que el resto
    // del sistema (recordatorios CRM, aviso VIP, etc.).
    const telefono = e => e.telefono_entrega || e.phone;
    const sinBloqueados = await blockedNumbers.filtrarNoBloqueados(pendientes, telefono);

    let enviados = 0;
    for (const entrega of sinBloqueados) {
        try {
            // Si un operador humano está manejando esta conversación ahora
            // mismo (pausa_hasta activa), no se interrumpe con un aviso
            // automático -- se reintentará en la próxima franja/día si
            // sigue pendiente.
            if (await enPausaHumana(telefono(entrega))) continue;

            const { mensaje, indice } = construirAvisoEntrega(entrega, franja);
            await enviarSeguro(telefono(entrega), mensaje);
            await entregasService.marcarAvisoEntregaEnviado(entrega.id, franja, indice);
            enviados++;
        } catch (e) {
            console.error(`❌ Error avisando entrega pendiente ${entrega.codigo || entrega.id}:`, e.message);
        }
    }
    return { enviados };
}

module.exports = {
    PLANTILLAS_MANANA,
    PLANTILLAS_TARDE,
    diaDelAnioSaoPaulo,
    elegirIndicePlantilla,
    construirAvisoEntrega,
    enviarAvisosEntregasPendientes
};
