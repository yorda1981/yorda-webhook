"use strict";

// ─────────────────────────────────────────────────────────
// REGLAS DEL BOT — funciones puras extraídas de los parches
// de src/services/openai.js
//
// Cada función de aquí es EXACTAMENTE la misma condición que
// ya vivía metida en el medio de procesarMensaje(), solo que
// ahora tiene nombre propio y se puede probar sola (ver
// test/reglas-bot.test.js) sin necesitar WhatsApp, base de
// datos, ni OpenAI reales.
//
// Estas funciones NO mandan mensajes ni tocan la base de
// datos — solo deciden SÍ/NO. openai.js sigue siendo el que
// hace las acciones (enviarSeguro, guardarCliente, etc.).
// ─────────────────────────────────────────────────────────

const ESTADOS_QUE_BLOQUEAN = ["aguardando_comprovante", "aguardando_numero_recarga", "confirmando_recarga"];

function clienteEstaOcupado(cliente) {
    return ESTADOS_QUE_BLOQUEAN.includes(cliente?.estado);
}

// NUEVA INTENCIÓN EXPLÍCITA > CONTEXTO CONVERSACIONAL ANTERIOR.
//
// Estos 4 estados son "reemplazables": representan una operación en curso
// que TODAVÍA no generó ninguna fila real en `operations` (agregarOperacion
// siempre limpia la sesión -- ver limpiarSesion en pix-flow.js -- en el
// mismo paso en que crea la fila, así que mientras alguno de estos 4
// estados sigue puesto, la fila real de `operations` simplemente no existe
// todavía). Por eso SÍ pueden reemplazarse sin riesgo cuando el cliente
// manda una intención nueva y explícita. Es un conjunto MÁS AMPLIO que
// ESTADOS_QUE_BLOQUEAN (usado en otros lados como esConsultaEntrega, donde
// ese criterio más angosto sigue siendo el correcto).
const ESTADOS_REEMPLAZABLES = [
    "cotizacion_realizada",
    "aguardando_comprovante",
    "seleccionando_recarga",
    "aguardando_numero_recarga",
    "confirmando_recarga"
];

function tieneContextoReemplazable(cliente) {
    return ESTADOS_REEMPLAZABLES.includes(cliente?.estado);
}

// Frases explícitas de abandono/cambio de intención -- el cliente pide
// arrancar de cero sin necesariamente traer un monto nuevo consigo (a
// diferencia de esEnvioNuevoSobreAbandonado). Igual que el resto de este
// archivo: nunca borra operations/entregas, solo permite resetear el
// contexto conversacional cuando el cliente lo pide con estas palabras.
function esFraseDeAbandonoExplicito(txt) {
    return /\b(olvida (eso|esto|lo anterior)|olvidalo|cancela (eso|esto|la operacion|el pedido|todo)|no era eso|no era esto|otra operacion|quiero hacer otra (operacion|cosa)|mejor cancela|deixa (isso|pra la)|cancela (isso|o pedido|tudo)|esquece (isso|aquilo)|nao era isso|deixa pra la)\b/.test(txt);
}

// FIX MENSAJE DUPLICADO — evita reenviar el PIX completo si el cliente
// manda la misma tarjeta varias veces seguidas mientras ya se espera el comprobante.
function esTarjetaDuplicada(cliente, tarjetaDetectada) {
    const yaGuardadaIgual = cliente?.tarjeta === tarjetaDetectada || cliente?.tarjeta_frecuente === tarjetaDetectada;
    const yaEsperandoComprobante = cliente?.estado === "aguardando_comprovante";
    return !!(yaGuardadaIgual && yaEsperandoComprobante && !cliente?.comprobante_pendiente);
}

// Consulta sobre entrega en efectivo / municipio — dispara la explicación +
// link de la calculadora solo si el cliente NO dio monto todavía y no está
// a mitad de un pago en curso.
function esConsultaEntrega(txt, montoValido, cliente) {
    const mencionaEntrega   = /entrega|entregan|entregar|domicilio|entregam/.test(txt);
    const mencionaEfectivo  = /efectivo|cash|dinheiro|espécie|especie/.test(txt);
    const mencionaMunicipio = /municipio|município/.test(txt);
    return !clienteEstaOcupado(cliente) && !montoValido && (mencionaEntrega || mencionaEfectivo || mencionaMunicipio);
}

// Si el cliente ya recibió la explicación completa de entrega hace poco (mismos
// minutos), no hace falta repetirle todo el texto — se le manda una versión corta.
const MINUTOS_REPETIR_ENTREGA = 3;
function yaAvisoEntregaReciente(cliente) {
    if (!cliente?.ultimo_aviso_entrega) return false;
    const minutos = (Date.now() - new Date(cliente.ultimo_aviso_entrega).getTime()) / 60000;
    return minutos < MINUTOS_REPETIR_ENTREGA;
}

// FIX 4 — un número solo ("200", sin la palabra "reales") también cuenta
// como monto válido para cotizar, siempre que el cliente no esté ocupado.
function esBareMontoValido(txt) {
    const soloNumeroTxt = txt.trim();
    const bareNumero = /^\d{2,5}$/.test(soloNumeroTxt) ? Number(soloNumeroTxt) : null;
    return bareNumero !== null && bareNumero >= 10 && bareNumero <= 50000 ? bareNumero : null;
}

// FIX 6 + FIX ENVÍO NUEVO SOBRE UNO ABANDONADO — decide si se puede cotizar
// un monto BRL nuevo. Si el cliente tiene un contexto "reemplazable" (ver
// ESTADOS_REEMPLAZABLES arriba) sin completar, solo se permite si el monto
// que menciona es DISTINTO al de esa operación vieja (en cuyo caso es un
// envío nuevo, no una continuación).
//
// `hayOperacionReal` lo calcula el caller (openai.js) consultando
// `operations` -- es la única razón real para NO reemplazar aunque el
// estado sea "reemplazable": si ya existe una fila real 'pendiente' para
// este cliente, hay un hecho financiero en curso y no se toca. En el flujo
// actual esto no debería pasar nunca mientras comprobante_pendiente sigue
// puesto (ver comentario de ESTADOS_REEMPLAZABLES), pero se deja como
// verificación explícita en vez de asumir el invariante para siempre.
function esEnvioNuevoSobreAbandonado(cliente, montoValido, valorFinal, hayOperacionReal = false) {
    return !!(
        tieneContextoReemplazable(cliente) &&
        montoValido &&
        !hayOperacionReal &&
        Number(cliente?.ultimo_monto) !== valorFinal
    );
}

function puedeCotizarBRL(cliente, montoValido, valorFinal, hayOperacionReal = false) {
    const ocupado = clienteEstaOcupado(cliente);
    if (!montoValido) return false;
    if (!ocupado) return true;
    return esEnvioNuevoSobreAbandonado(cliente, montoValido, valorFinal, hayOperacionReal);
}

// FIX LOOP (parte 2) — comprobante + tarjeta ya recibidos, solo faltaba el monto.
// Si el texto es SOLO un número (con o sin "reales"/"r$"), se cierra la operación
// directo en vez de volver a cotizar.
function esRespuestaSoloMonto(text) {
    return /^\s*r?\$?\s*\d{1,6}([.,]\d{1,2})?\s*(reales|reais|brl|r\$)?\s*$/i.test(text || "");
}

function debeCompletarConMontoPendiente(cliente, montoValido, text) {
    return !!(
        cliente?.comprobante_pendiente &&
        (cliente?.tarjeta || cliente?.tarjeta_frecuente) &&
        montoValido &&
        esRespuestaSoloMonto(text)
    );
}

// FIX 5 — "quiero 200 reales" no debe confirmar la cotización anterior, debe
// cotizar el monto nuevo. Solo se trata como confirmación si NO viene un monto.
function debeConfirmarCotizacion(cliente, esConfirma, montoValido) {
    return !!(esConfirma && cliente?.estado === "cotizacion_realizada" && !montoValido);
}

function tieneTarjetaGuardada(cliente) {
    return !!(cliente?.tarjeta || cliente?.tarjeta_frecuente);
}

// BUG VIEJO: esRecarga comparaba contra "recarga_etecsa" (que nunca se guarda de
// verdad) en vez de "recarga_nacional" / "recarga_internacional" — por eso las
// recargas se trataban como remesa normal y el mensaje mostraba "Recibe: 0 CUP".
function esRecarga(cliente) {
    return !!cliente?.tipo_favorito?.startsWith("recarga_");
}

// ─────────────────────────────────────────────────────────
// SELECCIÓN NATURAL DE RECARGA (cierre del módulo de Recargas)
//
// Estas funciones solo REFINAN un mensaje que ya está dentro de un flujo
// de recarga activo (`cliente.estado` en seleccionando_recarga/
// aguardando_numero_recarga/confirmando_recarga) -- nunca amplían el
// portón de gatillos por sí solas.
// ─────────────────────────────────────────────────────────

// Interpreta la respuesta del cliente contra las modalidades REALMENTE
// disponibles en ese momento (`opciones`, ya filtradas por leerRecargas()).
// Devuelve:
//   null       -> no reconoce nada, el caller debe pedir de nuevo
//   "AMBIGUO"  -> se refirió a algo puntual pero no se puede saber a cuál
//                 sin adivinar (ej. "la segunda" con una sola opción)
//   <tipo>     -> "nacional" | "internacional" (el tipo elegido, sin ambigüedad)
function interpretarSeleccionRecarga(txt, opciones) {
    if (!Array.isArray(opciones) || opciones.length === 0) return null;
    const t = txt.trim();
    const tipos = opciones.map(o => o.tipo);

    if (/^[1-9]$/.test(t)) {
        const idx = parseInt(t, 10) - 1;
        return idx >= 0 && idx < tipos.length ? tipos[idx] : "AMBIGUO";
    }
    if (/\bnacional\b/.test(t) && tipos.includes("nacional")) return "nacional";
    if (/\binternacional\b/.test(t) && tipos.includes("internacional")) return "internacional";
    if (/^(la )?primera$/.test(t)) return tipos.length >= 1 ? tipos[0] : "AMBIGUO";
    if (/^(la )?segunda$/.test(t)) return tipos.length >= 2 ? tipos[1] : "AMBIGUO";
    // "esa"/"esa misma"/confirmaciones sueltas -- SOLO inequívoco si hay
    // una única modalidad disponible; con 2+ opciones nunca se adivina.
    if (/^(esa( misma)?|si|sí|dale|ok|claro|correcto|vale|perfecto)$/.test(t)) {
        return opciones.length === 1 ? tipos[0] : null;
    }
    return null;
}

// Si el mensaje YA nombra explícitamente una modalidad por su nombre (ej.
// "quiero una recarga internacional"), permite ir directo a esa opción sin
// mostrar el menú -- solo cuando esa modalidad puntual está disponible.
function nombraModalidadRecarga(txt, opciones) {
    if (!Array.isArray(opciones)) return null;
    const tipos = opciones.map(o => o.tipo);
    if (/\binternacional\b/.test(txt) && tipos.includes("internacional")) return "internacional";
    if (/\bnacional\b/.test(txt) && tipos.includes("nacional")) return "nacional";
    return null;
}

// Cambios/cancelación dentro de un flujo de recarga activo (selección,
// número, o resumen de confirmación). Devuelve:
//   "confirmar"             -> el cliente aprueba el resumen/opción actual
//   "cambiar_numero"        -> quiere corregir el número cubano
//   "cambiar_nacional"      -> quiere cambiar a la modalidad Nacional
//   "cambiar_internacional" -> quiere cambiar a la modalidad Internacional
//   "cancelar"              -> quiere abandonar la recarga en curso
//   null                    -> no reconoce nada, sigue el flujo normal
function interpretarAccionRecarga(txt) {
    const t = txt.trim();
    if (/^(si|sí|dale|ok|confirmo|claro|correcto|vale|perfecto|confirmar)$/.test(t)) return "confirmar";
    if (/me equivoque de numero|no,? es para otro numero|no,? para otro numero|cambia(r)? el numero|otro numero/.test(t)) return "cambiar_numero";
    if (/mejor la nacional|cambia(r)? (a )?nacional/.test(t)) return "cambiar_nacional";
    if (/mejor la internacional|cambia(r)? (a )?internacional/.test(t)) return "cambiar_internacional";
    if (/\bcancela(r)?\b|\bdejalo\b|\bdeixa\b|\bdespues\b|\bdepois\b|\bme equivoque\b/.test(t)) return "cancelar";
    return null;
}

// Números móviles cubanos: 8 dígitos, empiezan en 5 (5XXXXXXX). Acepta con
// o sin el código de país +53 delante, con o sin espacios/guiones/"+".
// Devuelve el número normalizado al formato que ya usa el sistema (8
// dígitos, sin prefijo), o null si no tiene forma de número cubano válido
// -- nunca inventa ni completa dígitos faltantes.
function normalizarNumeroCubano(raw) {
    const soloDigitos = String(raw || "").replace(/\D/g, "");
    if (/^535\d{7}$/.test(soloDigitos)) return soloDigitos.slice(2);
    if (/^5\d{7}$/.test(soloDigitos)) return soloDigitos;
    return null;
}

// BUG VIEJO: estas 2 reglas solo reconocían frases en español — un cliente que
// escribía en portugués ("Posso passar reais", "Qual o valor do cup") no coincidía
// con ninguna regla y el mensaje caía en la IA de respaldo, que a veces decidía
// quedarse en silencio. Se agregaron los equivalentes en portugués.
function esConsultaTasas(txt) {
    return /a cuanto|a como|tasa.*hoy|cambio.*hoy|hoy.*cambio|hoy.*tasa|cual es la tasa|como esta el cambio|como esta la tasa|cuanto vale|cuanto esta|precio.*hoy|hoy.*precio|tasa de hoy|cambio de hoy|qual o valor|qual a taxa|quanto esta|quanto está|quanto vale|taxa de hoje|cambio de hoje|hoje.*taxa|taxa.*hoje/.test(txt);
}

function esIntencionSinMonto(txt) {
    return /quiero enviar|necesito enviar|quiero mandar|quiero hacer (una )?(remesa|transferencia)|necesito (una )?(remesa|transferencia)|posso (enviar|mandar|passar)|quero enviar|quero mandar|preciso enviar|quero fazer (uma )?(remessa|transferencia)|preciso (fazer )?(uma )?(remessa|transferencia)/.test(txt);
}

// ─────────────────────────────────────────────────────────
// CONTEXTO CONVERSACIONAL CORTO (customers.ultima_pregunta /
// ultimas_opciones / contexto_actualizado_at — migración 0011).
//
// Ventana DISTINTA e independiente de DOS_HORAS (aguardando_comprovante) y
// de cualquier otra regla de negocio (operations, entregas, comprobantes).
// Valor aprobado: 30 minutos. Si se vence, NUNCA se interpreta una
// respuesta corta contra la pregunta vieja — el estado de negocio
// (`cliente.estado`) y cualquier hecho financiero (operations, entregas,
// comprobante_pendiente) siguen intactos, solo se ignora el contexto corto.
//
// IMPORTANTE (regla del portón): estas funciones solo REFINAN la
// interpretación de un mensaje que YA pasó el portón de gatillos (porque
// `cliente?.estado` ya era verdadero, condición #3 de debeResponder en
// openai.js). Nunca deciden por sí solas que el bot debe responder.
// ─────────────────────────────────────────────────────────

const CONTEXTO_CORTO_TTL_MS = 30 * 60 * 1000; // 30 minutos (aprobado)

function contextoCortoVigente(cliente) {
    if (!cliente?.contexto_actualizado_at) return false;
    const edadMs = Date.now() - new Date(cliente.contexto_actualizado_at).getTime();
    return edadMs >= 0 && edadMs < CONTEXTO_CORTO_TTL_MS;
}

// RECUPERACIÓN DESPUÉS DE INTERVENCIÓN HUMANA.
//
// El contexto corto puede seguir vigente por TTL (30 min) pero haber
// quedado obsoleto porque el operador intervino manualmente en el medio
// (ver activarPausaHumana en webhook-guard.js, que estampa
// customers.pausa_hasta) -- esa conversación humana pudo resolver la
// pregunta pendiente sin que el bot se enterara. Por eso, además del TTL,
// se compara contra pausa_hasta: si la pregunta corta se guardó ANTES de
// la última vez que se activó/extendió la pausa, se considera
// potencialmente obsoleta y no se usa para interpretar una respuesta
// ambigua -- sin tocar ningún estado financiero ni el TTL en sí.
function contextoUtilizable(cliente) {
    if (!contextoCortoVigente(cliente)) return false;
    if (cliente?.pausa_hasta && cliente?.contexto_actualizado_at) {
        const contextoTs = new Date(cliente.contexto_actualizado_at).getTime();
        const pausaTs = new Date(cliente.pausa_hasta).getTime();
        if (contextoTs < pausaTs) return false;
    }
    return true;
}

// Interpreta "la primera"/"la segunda"/"la tercera"/"la otra"/"esa" contra
// las opciones mostradas en la última pregunta de selección de tarjeta.
// Devuelve:
//   null       -> no aplica (seguir con el resto del árbol, sin cambios)
//   "AMBIGUO"  -> el cliente se refirió a algo puntual pero no se puede
//                 saber a cuál sin adivinar -> el caller debe preguntar
//   <valor>    -> la opción elegida sin ambigüedad
function interpretarSeleccionOpcion(txt, cliente) {
    if (!contextoUtilizable(cliente)) return null;
    if (cliente?.ultima_pregunta !== "seleccion_tarjeta") return null;
    const opciones = Array.isArray(cliente?.ultimas_opciones) ? cliente.ultimas_opciones : [];
    if (opciones.length === 0) return null;

    const t = txt.trim();

    const ORDINALES = {
        "la primera": 0, "primera": 0, "1a": 0, "1ra": 0,
        "la segunda": 1, "segunda": 1, "2a": 1, "2da": 1,
        "la tercera": 2, "tercera": 2, "3a": 2, "3ra": 2
    };
    if (Object.prototype.hasOwnProperty.call(ORDINALES, t)) {
        const idx = ORDINALES[t];
        return idx < opciones.length ? opciones[idx] : "AMBIGUO";
    }

    // "la otra" solo es inequívoco en una elección BINARIA (2 opciones).
    if (/^(la )?otra$/.test(t)) {
        return opciones.length === 2 ? opciones[1] : "AMBIGUO";
    }

    // "esa" solo es inequívoco cuando había UNA sola opción referida.
    if (/^esa$/.test(t)) {
        return opciones.length === 1 ? opciones[0] : "AMBIGUO";
    }

    return null;
}

// "tarjeta" como palabra suelta -> usar la tarjeta ya guardada, SOLO si
// el bot está esperando justo eso (ultima_pregunta === "tarjeta_pendiente")
// y hay exactamente una tarjeta frecuente guardada (si no hay ninguna,
// no hay nada que reutilizar; nunca se adivina cuál si hubiera varias).
function interpretarTarjetaPorPalabra(txt, cliente) {
    if (!/^tarjeta$/i.test(txt.trim())) return null;
    if (!contextoUtilizable(cliente)) return null;
    if (cliente?.ultima_pregunta !== "tarjeta_pendiente") return null;
    return cliente?.tarjeta_frecuente || null;
}

// ─────────────────────────────────────────────────────────
// SEGUNDO SALTO DE NATURALIDAD — correcciones, pausas, cierre natural,
// confusión y exploración vs decisión. Todas puras (solo texto/cliente),
// igual que el resto del archivo.
// ─────────────────────────────────────────────────────────

// "esa tarjeta no"/"otra tarjeta"/"cambia la tarjeta" -- corrige el DATO
// tarjeta sin abandonar la operación completa (a diferencia de
// esFraseDeAbandonoExplicito, que resetea todo). El caller decide qué
// hacer (pedir una tarjeta nueva), esta función solo detecta la frase.
function esRechazoTarjeta(txt) {
    return /\besa tarjeta no\b|\bno es esa tarjeta\b|\bno era esa tarjeta\b|\botra tarjeta\b|\bcambia(r)?\s+(la\s+)?tarjeta\b|\bessa\s+n[aã]o\b|\boutro\s+cart[aã]o\b|\btroca\s+(o\s+)?cart[aã]o\b/.test(txt);
}

// Abandono TEMPORAL ("espera"/"todavía no"/"déjalo para mañana"/"después
// te mando el comprobante"/"no tengo dinero ahora") -- a diferencia de
// esFraseDeAbandonoExplicito, aquí el cliente NO pide cancelar ni empezar
// de cero: solo pide una pausa. El caller responde brevemente y NO debe
// tocar ni el estado financiero ni el contexto conversacional.
function esPausaTemporal(txt) {
    return /\bespera(te)?\b|\btodavia no\b|\bahora no\b|\bahorita no\b|\bmas tarde\b|\bdejalo para (mañana|manana|luego|despues)\b|\bdespues te (mando|paso|envio)\b|\bno tengo (el )?dinero( ahora)?\b|\bespera un (poco|momento)\b|\bagora nao\b|\bmais tarde\b|\bdepois eu (mando|envio)\b/.test(txt);
}

// Señales deterministas de confusión/frustración -- "no entendí", "no fue
// eso", repetir la misma pregunta. El caller decide cuántas veces seguidas
// hace falta verlo antes de ofrecer/hacer handoff humano.
function esSenalConfusion(txt) {
    return /\bno entendi\b|\bno entiendo\b|\bno fue eso\b|\beso no (fue|era) lo que (pregunte|pedi)\b|\bno es lo que pregunte\b|\bnao entendi\b|\bnao foi isso\b|\bnao era isso que perguntei\b/.test(txt);
}

// Cierre natural de la conversación ("gracias"/"listo"/"perfecto"/
// "entendido"/"después te aviso") -- el caller responde breve o se queda
// en silencio si el flujo ya estaba cerrado, nunca alarga la charla.
function esCierreNatural(txt) {
    return /^(gracias|ok gracias|listo|perfecto|entendido|vale|beleza|entendi|combinado|de acuerdo entonces)[\s!.]*$/.test(txt.trim()) ||
        /\bdespues te aviso\b|\bdepois te aviso\b|\bya pague.{0,15}despues te aviso\b/.test(txt);
}

// Cliente EXPLORANDO (no decidido todavía): pregunta genérica sobre el
// funcionamiento/las opciones, sin dar un monto. El caller debe explicar/
// cotizar sin empujarlo a completar una operación.
function esPreguntaExploratoria(txt) {
    return /\bcomo funciona\b|\bque opciones tienen\b|\bcuales? son las opciones\b|\bcuanto seria\b|\bcomo es el proceso\b|\bque necesito para enviar\b|\bcomo funciona isso\b|\bcomo funciona o processo\b|\bquais (as )?opcoes\b|\bquanto seria\b/.test(txt);
}

// ─────────────────────────────────────────────────────────
// HUMANIZACIÓN DE SALUDOS
//
// Funciones puras usadas por manejarSaludo() en openai.js. NUNCA deciden
// SI se saluda (eso lo sigue decidiendo el gate `esSaludo` existente, sin
// tocar) -- solo QUÉ franja usar y QUÉ nombre mostrar, dado que ya se
// decidió responder con un saludo.
// ─────────────────────────────────────────────────────────

// Franja según la hora real (America/Sao_Paulo) -- mismos cortes que ya
// usaba manejarSaludo() antes de esta fase (h<12 mañana, h<18 tarde, resto
// noche), solo que ahora es una función con nombre y testeable sola.
function franjaPorHora(horaSaoPaulo) {
    const h = Number(horaSaoPaulo);
    if (h < 12) return "manana";
    if (h < 18) return "tarde";
    return "noche";
}

// Si el cliente escribió explícitamente "buenos días"/"boa tarde"/etc.,
// se le corresponde con ESA franja (más natural que "corregirlo" con la
// hora real del servidor) -- null si el saludo es genérico ("hola"/"hi"),
// caso en el que el caller debe usar franjaPorHora() en su lugar.
function franjaSaludoExplicita(txt) {
    if (/\bbuenos? d[ií]as\b|\bbom dia\b/.test(txt)) return "manana";
    if (/\bbuenas tardes\b|\bboa tarde\b/.test(txt)) return "tarde";
    if (/\bbuenas noches\b|\bboa noite\b/.test(txt)) return "noche";
    return null;
}

// Nombre de pila "confiable" para usar en el saludo -- nunca se inventa:
// descarta vacíos y el placeholder genérico "Cliente" que usan varios
// flujos (ej. agregarOperacion) cuando no se conoce el nombre real. Si no
// hay nada confiable, devuelve null (el caller debe entonces saludar sin
// nombre, nunca con un valor inventado).
function primerNombreConfiable(nombre) {
    const limpio = String(nombre || "").trim();
    if (!limpio || limpio.toLowerCase() === "cliente") return null;
    return limpio.split(" ")[0];
}

module.exports = {
    franjaPorHora,
    franjaSaludoExplicita,
    primerNombreConfiable,
    clienteEstaOcupado,
    tieneContextoReemplazable,
    esFraseDeAbandonoExplicito,
    esTarjetaDuplicada,
    esConsultaEntrega,
    esBareMontoValido,
    esEnvioNuevoSobreAbandonado,
    puedeCotizarBRL,
    esRespuestaSoloMonto,
    debeCompletarConMontoPendiente,
    debeConfirmarCotizacion,
    tieneTarjetaGuardada,
    esRecarga,
    interpretarSeleccionRecarga,
    nombraModalidadRecarga,
    interpretarAccionRecarga,
    normalizarNumeroCubano,
    esConsultaTasas,
    esIntencionSinMonto,
    yaAvisoEntregaReciente,
    CONTEXTO_CORTO_TTL_MS,
    contextoCortoVigente,
    contextoUtilizable,
    interpretarSeleccionOpcion,
    interpretarTarjetaPorPalabra,
    esRechazoTarjeta,
    esPausaTemporal,
    esSenalConfusion,
    esCierreNatural,
    esPreguntaExploratoria
};
