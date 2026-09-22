"use strict";

// ─────────────────────────────────────────────────────────
// MOTOR DE MENSAJES DE RECUPERACIÓN — PREVIEW (sin envío)
//
// Arquitectura (separación estricta, de abajo hacia arriba):
//   1. datos comerciales reales     -> src/services/recuperacion.js
//      (candidato: nombre, tipoFavorito/servicio, fechaIntento, antigüedad)
//   2. este módulo (motor)          -> decide TONO según antigüedad real,
//                                       arma el POOL de familias/variantes
//                                       elegibles, selecciona una (rng
//                                       inyectable, nunca Math.random()
//                                       directo -- ver generarMensajePreview)
//   3. render del mensaje           -> las funciones de cada variante,
//                                       puras, solo interpolan nombre/
//                                       servicio ya validados -- NUNCA
//                                       inventan monto, tasa, disponibilidad
//                                       ni estado.
//
// El generador de lenguaje NUNCA decide ni modifica hechos comerciales
// (cantidad/moneda/tasa/estado/servicio) -- solo los recibe ya resueltos
// por recuperacion.js y elige CÓMO redactarlos. Si en el futuro se agrega
// IA para más variedad lingüística, debe conectarse en este mismo punto
// (reemplazando/ampliando las funciones de variante), sin tocar las capas
// 1 y 3 de abajo.
//
// Nada de esto escribe en la base de datos ni llama a zapi/WhatsApp -- es
// puro cálculo de texto a partir de datos ya leídos.
// ─────────────────────────────────────────────────────────

const { primerNombreConfiable } = require("./reglas-bot");

// ── Frase de servicio -- mapeo cerrado, nunca inventa ──────────────────
// Un tipo_favorito desconocido cae al genérico "aquel envío pa' Cuba" --
// nunca se inventa un servicio que no está confirmado en el dato real.
// Nota deliberada: efectivo dice explícitamente "entrega en efectivo" (no
// "envío"/"transferencia") y recarga dice explícitamente "recarga" -- así
// ninguna variante puede mezclar los conceptos aunque el texto genérico de
// la familia hable de "envío".
const FRASES_SERVICIO = {
    brl_cup:               "aquel envío a CUP",
    usd_clasica:            "aquellos USD",
    usd_prepago:            "aquellos USD",
    usd_pendiente_tipo:     "aquellos USD",
    mlc:                    "aquellos MLC",
    cup_efectivo:           "aquella entrega en efectivo (CUP)",
    usd_efectivo:           "aquella entrega en efectivo (USD)",
    recarga_nacional:       "aquella recarga",
    recarga_internacional:  "aquella recarga"
};

function fraseServicio(tipoFavorito) {
    return FRASES_SERVICIO[tipoFavorito] || "aquel envío pa' Cuba";
}

// ── Tono por antigüedad -- más fino que el antiguedadDe() de
// recuperacion.js (que solo clasifica la columna visual del dashboard).
// Este es exclusivamente para decidir cuánta libertad de humor tiene el
// motor, nunca se muestra al cliente. ──
function antiguedadTono(fechaIntento, ahora = new Date()) {
    if (!fechaIntento) return "2h-24h";
    const horas = (ahora.getTime() - new Date(fechaIntento).getTime()) / 3600000;
    if (horas < 24) return "2h-24h";
    if (horas < 3 * 24) return "1-3d";
    if (horas < 7 * 24) return "4-7d";
    return ">7d";
}

// ── Familias de mensaje ──────────────────────────────────────────────
// Cada variante es (ctx) => texto. ctx = { nombre, servicio } -- nombre ya
// viene filtrado por primerNombreConfiable (null si no es confiable, NUNCA
// se inventa), servicio ya viene de fraseServicio (nunca inventado).
//
// Revisión lingüística (2da ronda, tras feedback de tono):
//  - tasa_curiosidad NUNCA valora la tasa ("buena"/"interesante"/"conviene
//    aprovechar") -- solo gancho de curiosidad, nunca una afirmación
//    financiera (el motor no recibe ninguna tasa real del backend en esta
//    fase, así que no hay nada que valorar honestamente).
//  - Ningún cierre invita a abandonar la compra ("lo dejamos para otra
//    vida", "lo dejamos así") -- siempre orientado a retomar.
//  - Se evitó lenguaje que suene obsesivo ("sin ningún motivo en
//    particular", "perdí la cuenta de las veces que pensé en escribirte").
//  - Variedad real de longitud: hay una-línea, dos-líneas (\n) y algunas
//    más conversacionales.
//  - Nombre mezclado de verdad: variantes sin nombre en absoluto, con
//    nombre al inicio, y con nombre a mitad/final de frase.
//  - Cierres variados ("¿le damos?", "¿qué hacemos?", "tú me dices",
//    "aquí estoy", "¿resolvemos hoy?", y varias sin pregunta final) --
//    "¿seguimos?"/"¿lo retomamos?" ya no es el cierre por defecto.
//  - La broma de "ayuda de costo" sigue como ocurrencia ocasional (1 de
//    10 en la familia broma), nunca como confirmación financiera: sin
//    fecha, sin monto, sin afirmar que el cliente cobró algo real.
const FAMILIAS = {
    me_acorde: {
        variantes: [
            (ctx) => `${ctx.nombre ? ctx.nombre + ", estaba" : "Estaba"} hablando con un colega aquí y me acordé de ti 😂\n¿qué pasó al final con ${ctx.servicio}?`,
            (ctx) => `Se me vino a la mente lo de Cuba de la nada 😄`,
            (ctx) => `¿Qué fue de ${ctx.servicio}?${ctx.nombre ? " " + ctx.nombre : ""} 😊`,
            (ctx) => `Hoy alguien mencionó Cuba y pensé en lo de ${ctx.servicio}, que quedó pendiente.`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", " : ""}me acordé de ti hoy 😄 ¿le damos a ${ctx.servicio}?`,
            (ctx) => `Pasaba por aquí y me acordé de una cosita pendiente 😅\n¿la resolvemos?`,
            (ctx) => ctx.nombre
                ? `Justo hoy me acordé de ti, ${ctx.nombre} 😄 ¿le echamos otro vistazo a ${ctx.servicio}?`
                : `Justo hoy me acordé de ti 😄 ¿le echamos otro vistazo a ${ctx.servicio}?`,
            (ctx) => `Me acordé de lo de Cuba y dije: déjame escribir antes que se me olvide otra vez 😂`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", " : ""}quedó pendiente lo de ${ctx.servicio} y se me quedó dando vueltas. ¿Cómo vamos con eso?`,
            (ctx) => `Me acordé de ti 😊 ¿aquello de Cuba sigue en pie?`
        ]
    },
    dia_de_envio: {
        variantes: [
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿" : "¿"}tú sabes qué día es hoy? 😂\nDía de resolver ${ctx.servicio} 🇨🇺`,
            (ctx) => `Hoy amaneció con cara de envío pa' Cuba 😂🇨🇺`,
            (ctx) => `👀 ¿y ${ctx.servicio}?${ctx.nombre ? " " + ctx.nombre : ""} 😂`,
            (ctx) => `Hoy tiene pinta de día de envío pa' Cuba 👀`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", C" : "C"}uba está llamando 📞🇨🇺 ¿la atendemos hoy?`,
            (ctx) => `Se me ocurrió justo hoy 😄\n¿lo hacemos de una vez?`,
            (ctx) => `¿Qué vuelta${ctx.nombre ? ", " + ctx.nombre : ""}? 😄 ¿Resolvemos hoy lo de Cuba?`,
            (ctx) => `Hoy pensé: día de resolver ${ctx.servicio} 😄`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", " : ""}hoy tiene toda la pinta de ser el día ideal para ${ctx.servicio}, ¿tú qué dices?`
        ]
    },
    // Deliberadamente SIN ninguna cifra de tasa NI ninguna valoración
    // ("está buena"/"conviene aprovechar"/"anda interesante") -- el motor
    // no recibe una tasa real del backend en esta fase, así que no hay
    // nada que valorar honestamente. Solo curiosidad/gancho, nunca una
    // afirmación financiera.
    tasa_curiosidad: {
        variantes: [
            (ctx) => `${ctx.nombre ? ctx.nombre + ", " : ""}👀 ¿viste cómo está la tasa hoy?`,
            (ctx) => `¿Ya miraste la tasa de hoy? 😄`,
            (ctx) => `Estaba mirando la tasa y me acordé de ti${ctx.nombre ? ", " + ctx.nombre : ""} 😂`,
            (ctx) => `${ctx.nombre ? ctx.nombre + " 👀 ¿l" : "¿L"}e echaste un vistazo a la tasa hoy?`,
            (ctx) => ctx.nombre
                ? `Hoy me dio por mirar la tasa y dije: déjame escribirle a ${ctx.nombre} 😂`
                : `Hoy me dio por mirar la tasa y dije: déjame escribirte 😂`,
            (ctx) => `Vi la tasa de hoy y me acordé de ${ctx.servicio}${ctx.nombre ? ", " + ctx.nombre : ""}.`,
            (ctx) => `Che${ctx.nombre ? ", " + ctx.nombre : ""} 👀 ¿chequeaste la tasa hoy?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", m" : "M"}e dio curiosidad la tasa de hoy 😄 ¿la viste?`
        ]
    },
    broma: {
        variantes: [
            (ctx) => `Ese envío todavía anda por aquí buscándote 😂${ctx.nombre ? " " + ctx.nombre : ""}`,
            (ctx) => `Yo dije: seguro ${ctx.nombre || "te"} ${ctx.nombre ? "se olvidó" : "olvidaste"} de nosotros 😂 ¿le damos hoy a ${ctx.servicio}?`,
            (ctx) => `¿Lo hacemos hoy o seguimos dándole vueltas? 👀${ctx.nombre ? " " + ctx.nombre : ""}`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", hace" : "Hace"} rato quería escribirte por ${ctx.servicio} 😅`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", t" : "T"}e extraño por aquí 😂 ¿le damos a ${ctx.servicio}?`,
            (ctx) => `Me acordé de lo de Cuba y dije: déjame escribirle antes que se me vuelva a olvidar 😂${ctx.nombre ? " " + ctx.nombre : ""}`,
            // Broma coloquial/gancho -- NUNCA una confirmación financiera:
            // sin fecha, sin monto, sin afirmar que el cliente cobró nada
            // personalmente. Aparece 1 de 10 en esta familia, a propósito.
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ya" : "Ya"} la prefeitura está pagando la ayuda de costo 😂 ¿hacemos ${ctx.servicio}?`,
            (ctx) => `¿Seguimos con ${ctx.servicio}? 😂${ctx.nombre ? " " + ctx.nombre : ""}`,
            (ctx) => `${ctx.nombre ? ctx.nombre + " 😄 e" : "E"}sto ya se está poniendo largo... ¿le damos hoy?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", y" : "Y"}o lo dejo caer por aquí 😂 ¿qué hacemos con ${ctx.servicio}?`
        ]
    },
    recordatorio_normal: {
        variantes: [
            (ctx) => `Hola${ctx.nombre ? " " + ctx.nombre : ""} 😊 quedó pendiente lo de ${ctx.servicio}. Si todavía lo necesitas, aquí estoy.`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", s" : "S"}igue pendiente lo de ${ctx.servicio}. Tú me dices 😄`,
            (ctx) => `Hola${ctx.nombre ? " " + ctx.nombre : ""}, ¿sigues interesado en ${ctx.servicio}?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + " 😊 " : "Hola 😊 "}sigo disponible para ${ctx.servicio} cuando gustes.`,
            (ctx) => `Hola${ctx.nombre ? " " + ctx.nombre : ""}, quedó pendiente lo que habíamos hablado. Aquí estoy.`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", p" : "P"}or aquí sigo, disponible para ${ctx.servicio}.`,
            (ctx) => `Hola${ctx.nombre ? " " + ctx.nombre : ""} 😊 ¿qué hacemos con esto?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", c" : "C"}ualquier novedad sobre ${ctx.servicio}, tú me dices.`
        ]
    },
    // Solo se agrega al pool cuando SÍ hay un tipo_favorito real conocido
    // (ver familiasElegibles) -- nunca se usa para inventar un servicio.
    servicio_especifico: {
        variantes: [
            (ctx) => `${ctx.nombre ? ctx.nombre + " 👀 ¿q" : "¿Q"}ué hacemos con ${ctx.servicio}?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿l" : "¿L"}e damos a ${ctx.servicio} o cambiaste de idea?`,
            (ctx) => `Oye${ctx.nombre ? " " + ctx.nombre : ""}, lo de ${ctx.servicio} sigue ahí. ¿Resolvemos hoy?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + " 😊 ¿t" : "¿T"}odavía te interesa lo de ${ctx.servicio}?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", q" : "Q"}uedó pendiente lo de ${ctx.servicio}. Tú me dices 😄`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿e" : "¿E"}n qué quedamos con ${ctx.servicio}?`,
            (ctx) => `No me olvidé de ${ctx.servicio}${ctx.nombre ? ", " + ctx.nombre : ""}. Aquí estoy.`,
            (ctx) => `${ctx.nombre ? ctx.nombre + " 👀 s" : "S"}e me quedó dando vueltas en la cabeza lo de ${ctx.servicio}.`,
            (ctx) => `Che${ctx.nombre ? ", " + ctx.nombre : ""}, ¿cerramos lo de ${ctx.servicio}?`
        ]
    }
};

// ── Qué familias son elegibles según el tono (antigüedad) ──────────────
// No es una regla rígida de "una sola familia por período": cada tono
// tiene VARIAS familias posibles, con distinto peso (una familia repetida
// en la lista pesa más al elegir). 2h-24h prioriza el recordatorio simple
// (poco humor); >7d permite más broma/reactivación -- pero ninguna queda
// 100% excluida salvo servicio_especifico (que depende del dato real).
const FAMILIAS_POR_TONO = {
    "2h-24h": ["recordatorio_normal", "recordatorio_normal", "me_acorde"],
    "1-3d":   ["me_acorde", "recordatorio_normal", "dia_de_envio", "tasa_curiosidad"],
    "4-7d":   ["me_acorde", "dia_de_envio", "broma", "tasa_curiosidad", "recordatorio_normal"],
    ">7d":    ["me_acorde", "broma", "broma", "dia_de_envio", "tasa_curiosidad", "recordatorio_normal"]
};

function familiasElegibles(tono, tieneServicioReal) {
    const base = [...(FAMILIAS_POR_TONO[tono] || FAMILIAS_POR_TONO["1-3d"])];
    if (tieneServicioReal) base.push("servicio_especifico");
    return base;
}

// Cantidad total de opciones (familia, variante) realmente disponibles
// para este candidato -- usada para saber si "otra variante" tiene a
// dónde ir.
function totalOpciones(tono, tieneServicioReal) {
    const nombresUnicos = new Set(familiasElegibles(tono, tieneServicioReal));
    let total = 0;
    for (const nombre of nombresUnicos) total += FAMILIAS[nombre].variantes.length;
    return total;
}

// ── Selección determinista/inyectable -- NUNCA Math.random() directo.
// `rng` es una función () => number en [0,1) -- por defecto Math.random,
// pero los tests pueden inyectar una secuencia fija para reproducibilidad.
// `excluir` = { familia, indice } de la variante mostrada inmediatamente
// antes (para "🔄 Otra variante") -- si hay más de una opción disponible,
// nunca vuelve a elegir exactamente esa misma. ──
function elegirFamiliaVariante(candidato, { rng = Math.random, excluir = null } = {}) {
    const tono = antiguedadTono(candidato.fechaIntento);
    const tieneServicioReal = !!candidato.tipoFavorito;
    const familias = familiasElegibles(tono, tieneServicioReal);
    const opcionesDisponibles = totalOpciones(tono, tieneServicioReal);

    const MAX_INTENTOS = 8;
    for (let intento = 0; intento < MAX_INTENTOS; intento++) {
        const familia = familias[Math.floor(rng() * familias.length)];
        const variantes = FAMILIAS[familia].variantes;
        const indice = Math.floor(rng() * variantes.length);
        const esIgualAExcluido = excluir && familia === excluir.familia && indice === excluir.indice;
        if (!esIgualAExcluido || opcionesDisponibles <= 1) {
            return { familia, indice, tono };
        }
    }
    // Fallback defensivo (no debería llegar acá salvo rng degenerado): la
    // primera variante de la primera familia elegible.
    const familia = familias[0];
    return { familia, indice: 0, tono };
}

// ── Render final -- arma ctx (nombre/servicio ya resueltos, nunca
// inventados) y llama a la función de la variante elegida. ──
function renderizarMensaje(candidato, { familia, indice }) {
    const ctx = {
        nombre: primerNombreConfiable(candidato.nombre),
        servicio: fraseServicio(candidato.tipoFavorito)
    };
    return FAMILIAS[familia].variantes[indice](ctx);
}

// Reconstruye exclusivamente una variante que pertenece al pool actual para
// ese candidato. El cliente nunca puede suministrar texto arbitrario: solo
// familia+índice, que se valida contra tono, servicio y límites vigentes.
function construirVarianteAprobada(candidato, { familia, indice }) {
    if (!candidato || typeof familia !== "string" || !Number.isInteger(indice)) return null;
    const tono = antiguedadTono(candidato.fechaIntento);
    const elegibles = familiasElegibles(tono, !!candidato.tipoFavorito);
    if (!elegibles.includes(familia)) return null;
    if (!FAMILIAS[familia] || indice < 0 || indice >= FAMILIAS[familia].variantes.length) return null;
    return {
        mensaje: renderizarMensaje(candidato, { familia, indice }),
        familia,
        indice,
        tono,
        servicio: candidato.servicio || fraseServicio(candidato.tipoFavorito)
    };
}

// ── Punto de entrada del preview -- combina selección + render, y agrega
// los metadatos que el dashboard muestra de forma discreta (familia,
// servicio, antigüedad) SIN que formen parte del texto que vería el
// cliente. No escribe nada -- devolver { familia, indice } ya deja la
// arquitectura lista para que una fase futura, cuando SÍ se habilite el
// envío, pueda persistir "familia usada / variante usada / fecha" y evitar
// repetir lo mismo poco después al mismo cliente. ──
function generarMensajePreview(candidato, { rng = Math.random, excluir = null } = {}) {
    const { familia, indice, tono } = elegirFamiliaVariante(candidato, { rng, excluir });
    const mensaje = renderizarMensaje(candidato, { familia, indice });
    return {
        phone: candidato.phone,
        mensaje,
        familia,
        indice,
        servicio: candidato.servicio || fraseServicio(candidato.tipoFavorito),
        antiguedadTono: tono,
        opcionesDisponibles: totalOpciones(tono, !!candidato.tipoFavorito),
        generadoEn: new Date().toISOString()
    };
}

module.exports = {
    fraseServicio,
    antiguedadTono,
    familiasElegibles,
    totalOpciones,
    elegirFamiliaVariante,
    renderizarMensaje,
    construirVarianteAprobada,
    generarMensajePreview,
    FAMILIAS
};
