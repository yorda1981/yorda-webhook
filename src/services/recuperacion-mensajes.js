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
// Un tipo_favorito desconocido cae al genérico "un envío" --
// nunca se inventa un servicio que no está confirmado en el dato real.
// Nota deliberada: efectivo dice explícitamente "entrega en efectivo" (no
// "envío"/"transferencia") y recarga dice explícitamente "recarga" -- así
// ninguna variante puede mezclar los conceptos aunque el texto genérico de
// la familia hable de "envío".
const FRASES_SERVICIO = {
    brl_cup:               "un envío a CUP",
    usd_clasica:           "un envío en USD",
    usd_prepago:           "un envío en USD",
    usd_pendiente_tipo:    "un envío en USD",
    mlc:                   "un envío en MLC",
    cup_efectivo:          "una entrega en efectivo (CUP)",
    usd_efectivo:          "una entrega en efectivo (USD)",
    recarga_nacional:      "una recarga",
    recarga_internacional: "una recarga"
};

function fraseServicio(tipoFavorito) {
    return FRASES_SERVICIO[tipoFavorito] || "un envío";
}

// La familia servicio_especifico usa una forma hablada del dato ya resuelto;
// no cambia el servicio, solo quita la redacción de ficha técnica.
function fraseServicioConversacional(frase) {
    const texto = String(frase || "un envío");
    const efectivo = texto.match(/^una entrega en efectivo \((CUP|USD)\)$/);
    if (efectivo) return `${efectivo[1]} en efectivo`;
    const transferencia = texto.match(/^un envío (?:a|en) (CUP|USD|MLC)$/);
    if (transferencia) return transferencia[1];
    return texto;
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
            (ctx) => `${ctx.nombre ? ctx.nombre + ", m" : "M"}e acordé de ti y pasé por aquí 😄`,
            () => `Se me ocurrió saludarte hoy 😊`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿q" : "¿Q"}ué vuelta?`,
            () => `Pasé por aquí y dije: voy a saludar.`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿" : "¿"}cómo va todo?`,
            () => `Me acordé de ti esta mañana.`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿" : "¿"}todo bien por ahí?`,
            () => `Hoy me acordé de ti 😂`,
            () => `Te mando un saludo por aquí 😊`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿" : "¿"}hacemos un envío?`
        ]
    },
    dia_de_envio: {
        variantes: [
            (ctx) => `${ctx.nombre ? ctx.nombre + ", b" : "B"}uenos días 😊 ¿cómo estás?`,
            () => `Buen día 🌞 ¿cómo amaneciste?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", h" : "H"}oy podemos mandar algo.`,
            () => `Buenos días. ¿Cómo está la cosa?`,
            (ctx) => `Buen día${ctx.nombre ? " " + ctx.nombre : ""} ¿todo bien?`,
            () => `Hoy está bonito el día 😄`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿" : "¿"}mandamos algo hoy?`,
            (ctx) => `Buen día${ctx.nombre ? ", " + ctx.nombre : ""}, pasando a saludarte.`,
            (ctx) => `¿Qué vuelta${ctx.nombre ? ", " + ctx.nombre : ""}? Hoy podemos hacer un envío.`
        ]
    },
    // El nombre histórico de esta familia se conserva por compatibilidad,
    // pero sus variantes normales ya no afirman nada sobre tasas.
    tasa_curiosidad: {
        variantes: [
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿v" : "¿V"}iste qué rápido se fue la mañana?`,
            () => `Buen día 😊 ¿cómo va todo?`,
            () => `Pasando por aquí a saludarte.`,
            (ctx) => `${ctx.nombre ? ctx.nombre + " 👀 ¿c" : "¿C"}ómo amaneciste?`,
            () => `Me acordé de ti y vine a decir hola.`,
            () => `Hoy me dio por escribirte 😄`,
            () => `¿Todo bien por ahí?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿" : "¿"}hacemos un envío hoy?`
        ]
    },
    broma: {
        variantes: [
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿q" : "¿Q"}ué vuelta? 😄`,
            () => `Yo dije: voy a pasar a saludar 😂`,
            () => `¿Ya se despertó el día por ahí? 👀`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿" : "¿"}todo bien o qué?`,
            () => `Pasé por aquí antes de que se me olvidara saludarte 😂`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿" : "¿"}mandamos algo hoy?`,
            () => `Me acordé de ti y vine a saludar 😂`,
            (ctx) => `¿Qué vuelta${ctx.nombre ? ", " + ctx.nombre : ""}? ¿Cómo está la cosa?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿" : "¿"}hacemos un envíito? 😄`,
            () => `Buen día, no podía pasar sin saludarte 😂`
        ]
    },
    recordatorio_normal: {
        variantes: [
            (ctx) => `Hola${ctx.nombre ? " " + ctx.nombre : ""} 😊 ¿cómo estás?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿" : "¿"}cómo va todo?`,
            (ctx) => `Buen día${ctx.nombre ? " " + ctx.nombre : ""} ¿todo bien?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", p" : "P"}asando a saludarte.`,
            (ctx) => `¿Cómo amaneciste${ctx.nombre ? ", " + ctx.nombre : ""}?`,
            () => `Hola 😊 ¿qué tal el día?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿" : "¿"}hacemos un envío hoy?`,
            (ctx) => `Buenos días${ctx.nombre ? ", " + ctx.nombre : ""}. Me acordé de ti.`
        ]
    },
    // Solo se agrega al pool cuando SÍ hay un tipo_favorito real conocido
    // (ver familiasElegibles) -- nunca se usa para inventar un servicio.
    servicio_especifico: {
        variantes: [
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿" : "¿"}mandamos ${ctx.servicioConversacional} hoy?`,
            (ctx) => `Buen día${ctx.nombre ? ", " + ctx.nombre : ""} 😊 ¿mandamos algo hoy?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", ¿" : "¿"}hacemos ${ctx.servicioConversacional} hoy?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + " 👀 ¿m" : "¿M"}andamos ${ctx.servicioConversacional}?`,
            (ctx) => `Pasando a saludarte${ctx.nombre ? ", " + ctx.nombre : ""} 😄`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", " : ""}${ctx.servicioConversacional === "una recarga" ? "¿hacemos una recarga hoy?" : "¿hacemos un envío hoy?"}`,
            (ctx) => `Buenos días${ctx.nombre ? ", " + ctx.nombre : ""}. ¿Cómo estás?`,
            (ctx) => `${ctx.nombre ? ctx.nombre + ", h" : "H"}oy podemos mandar ${ctx.servicioConversacional}.`,
            (ctx) => `¿Qué vuelta${ctx.nombre ? ", " + ctx.nombre : ""}?`
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
        servicio: fraseServicio(candidato.tipoFavorito),
        servicioConversacional: fraseServicioConversacional(fraseServicio(candidato.tipoFavorito))
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
