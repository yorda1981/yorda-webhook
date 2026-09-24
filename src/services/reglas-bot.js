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

const { fechaSaoPaulo } = require("../utils/timezone");

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
// NORMALIZACIÓN DE VOCABULARIO PARA CLASIFICAR INTENCIÓN.
//
// Recibe texto ya pasado por norm() (minúsculas y sin tildes, así que
// "câmbio"->"cambio", "envío"->"envio", "transferência"->"transferencia")
// y colapsa variantes ES/PT a una sola forma canónica, para que los
// clasificadores de abajo razonen por CONCEPTO y no por frase exacta.
// Solo se usa para decidir intención: nunca para extraer montos ni para
// armar texto que se le manda al cliente.
const SINONIMOS_INTENCION = [
    [/\bhj\b/g, "hoje"],
    [/\b(taxas?|tasas)\b/g, "tasa"],
    [/\bcambios\b/g, "cambio"],
    [/\bcotacao\b/g, "cotizacion"],
    [/\benvi(o|os|ar|a|e|amos)\b/g, "enviar"],
    [/\bmand(o|a|e|ar|amos)\b/g, "mandar"],
    [/\b(transferencias?|transfiero|transferir)\b/g, "transferir"],
    [/\b(remessas?|remesas)\b/g, "remesa"],
    [/\b(dinheiro|plata)\b/g, "dinero"],
    [/\bpra\b/g, "para"]
];

function canonizarIntencion(txt) {
    let c = String(txt || "");
    for (const [re, reemplazo] of SINONIMOS_INTENCION) c = c.replace(re, reemplazo);
    return c;
}

const TASAS_FRASES = /a cuanto|a como|tasa.*hoy|cambio.*hoy|hoy.*cambio|hoy.*tasa|cual es la tasa|como esta el cambio|como esta la tasa|cuanto vale|cuanto esta|precio.*hoy|hoy.*precio|tasa de hoy|cambio de hoy|qual o valor|qual a taxa|quanto esta|quanto está|quanto vale|taxa de hoje|cambio de hoje|hoje.*taxa|taxa.*hoje/;

// Además de las frases históricas, reconoce por concepto: menciona la
// tasa/el cambio Y pregunta por su valor actual ("o câmbio como está hj",
// "cambio hoy", "qual a taxa hoje"), en cualquier orden. La rama conceptual
// no aplica si el mensaje trae números (eso lo resuelven los flujos de
// cotización con monto) ni si habla de tarjeta ("cambio de tarjeta").
function esConsultaTasas(txt) {
    return TASAS_FRASES.test(txt) || esConsultaTasasPorConcepto(txt);
}

function esConsultaTasasPorConcepto(txt) {
    const c = canonizarIntencion(txt);
    if (/\d/.test(c) || /\b(tarjeta|cartao)\b/.test(c)) return false;
    const mencionaTasa    = /\b(tasa|cambio|cotizacion)\b/.test(c);
    const pideValorActual = /\b(hoy|hoje|ahora|agora|como|cuanto|quanto|cual|qual)\b/.test(c) || c.includes("?");
    return mencionaTasa && pideValorActual;
}

const INTENCION_FRASES = /quiero enviar|necesito enviar|quiero mandar|quiero hacer (una )?(remesa|transferencia)|necesito (una )?(remesa|transferencia)|posso (enviar|mandar|passar)|quero enviar|quero mandar|preciso enviar|quero fazer (uma )?(remessa|transferencia)|preciso (fazer )?(uma )?(remessa|transferencia)/;

// Además de las frases históricas, reconoce por concepto: verbo de deseo/
// necesidad + (hasta 3 palabras) + acción de envío ("quero realizar envio a
// Cuba", "quiero hacer un envío", "quero fazer um envio"). Reconocer la
// intención NO fija monto ni inicia operación: el caller solo pregunta
// cuánto. Si lo que se quiere mandar es un comprobante/foto/pix, no es
// intención de envío de dinero.
function esIntencionSinMonto(txt) {
    if (INTENCION_FRASES.test(txt)) return true;
    const c = canonizarIntencion(txt);
    if (/\b(foto|fotos|comprobante|comprovante|documento|pix|imagen|imagem|captura|print|mensaje|mensagem|audio)\b/.test(c)) return false;
    return /\b(quiero|quero|necesito|preciso|deseo|quisiera|gostaria de|me gustaria|puedo|posso)\b(\s+\S+){0,3}?\s+(enviar|mandar|transferir|remesa)\b/.test(c);
}

// SALUDO NATURAL / COMBINADO.
//
// Antes el saludo solo se reconocía si el mensaje era EXACTAMENTE uno de
// una lista ("hola", "buenas tardes"...): "Hola buenas noches", "Hola,
// buenos días" o "Hola" + "Buenas" juntados por el debounce no eran saludo
// ni tenían gatillo -> el portón los descartaba en silencio. Ahora se
// consumen saludos del INICIO del texto (uno o varios, con puntuación,
// saltos de línea o emojis entre medio) y se devuelve lo que queda:
//   { tieneSaludo: false }                      -> no empieza con saludo
//   { tieneSaludo: true, resto: "" }            -> solo saludo
//   { tieneSaludo: true, resto: "<intención>" } -> saludo + algo más
// `resto` conserva el texto ORIGINAL (tildes, mayúsculas) para que el
// resto del router lo procese como si hubiera llegado solo.
const SALUDOS = [
    "buenas tardes", "buenas noches", "buenos dias", "buen dia", "buenas", "buenos",
    "boa tarde", "boa noite", "bom dia", "boas",
    "good morning", "hola", "ola", "oie", "oi", "hey", "hello", "hi",
    "e ai", "eai", "que tal", "saludos"
];
// Solo se consumen DESPUÉS de un saludo ("hola Yordanys", "oi amigo").
const VOCATIVOS = ["yordanys", "yorda", "bot", "amigo", "amiga", "hermano", "mano"];
const SEPARADORES_SALUDO = /^[\s,.;:!?¡¿…\-–—~*()\p{Extended_Pictographic}\uFE0F\u200D]+/u;

function separarSaludo(text) {
    const original = String(text || "").normalize("NFC");
    const n = original.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC");
    // Mapeo 1:1 original<->normalizado (válido para texto NFC en alfabeto
    // latino); si no, se trabaja sobre el normalizado.
    const base = n.length === original.length ? original : n;
    let i = 0, tieneSaludo = false;
    const saltarSeparadores = () => { const m = n.slice(i).match(SEPARADORES_SALUDO); if (m) i += m[0].length; };
    const consumir = (lista) => {
        for (const w of lista) {
            if (n.startsWith(w, i) && !/[a-z0-9]/.test(n.charAt(i + w.length))) { i += w.length; return true; }
        }
        return false;
    };
    saltarSeparadores();
    while (consumir(SALUDOS)) {
        tieneSaludo = true;
        saltarSeparadores();
        if (consumir(VOCATIVOS)) saltarSeparadores();
    }
    return { tieneSaludo, resto: tieneSaludo ? base.slice(i).trim() : String(text || "") };
}

// CONSULTA DE ESTADO / SEGUIMIENTO de una operación PROPIA, por concepto:
// referencia a "mi/meu/minha" + envío/transferencia/operación/remesa/
// pedido/dinero/pago (normalizado con canonizarIntencion) Y una señal de
// seguimiento (estado, cómo va, ya salió/llegó, cuándo llega, qué pasó,
// demora...). Exigir el posesivo evita confundirlo con preguntas generales
// ("cómo va todo", "cómo está el cambio").
const OBJETO_OPERACION_PROPIA = /\b(mi|mis|meu|minha|meus|minhas|nuestro|nuestra)\s+(enviar|transferir|operacion|operaciones|operacao|remesa|pedido|dinero|pago|pagamento|deposito)\b/;
const SENAL_SEGUIMIENTO = /\b(estado|status|situacion|seguimiento|andamento|como (va|vai|anda|esta|sigue)|ya (salio|llego|esta|se hizo|lo hicieron)|salio|llego|chegou|saiu|cuando (llega|sale)|quando (chega|sai)|que (paso|sucedio)|o que (houve|aconteceu)|paso algo|demora|tarda|falta|novedad|novedades|noticias|listo|pronto)\b/;

function esConsultaEstadoOperacion(txt) {
    const c = canonizarIntencion(txt);
    return OBJETO_OPERACION_PROPIA.test(c) && SENAL_SEGUIMIENTO.test(c);
}

// ── CONTEXTO DE PAGO ──

// Pedido del PIX / de la clave para pagar, por CONCEPTO (verbo de pedido +
// pix/chave/llave/clave, en cualquier orden y con "por favor" alrededor),
// no por frase exacta: "Puede enviar o pix", "manda o pix por favor",
// "qual a chave?". Nunca cuando el cliente dice que YA pagó (eso es
// comprobante verbal).
function esPedidoDePix(txt) {
    const t = String(txt || "").replace(/\s+/g, " ").trim();
    if (!/\b(pix|chave|llave|clave)\b/.test(t)) return false;
    if (/\b(fiz|hice|paguei|pague|mandei|enviei|transferi|feito|realizado|comprovante|comprobante)\b|\bya (mande|envie|pague)\b/.test(t)) return false;
    return /^(el |o |a |la )?(pix|chave|llave|clave)( pix)?( por favor| pf| pfv| porfa)?[?!.]*$/.test(t) ||
        /\b(manda|mande|mandar|mandame|mandas|envia|envie|enviar|enviame|envias|pasa|pasame|pasas|passa|passe|passar|da|dame|me da|cual|qual|quero|quiero|pode|puede|podes|puedes|poderia|podria|necesito|preciso)\b.{0,25}\b(pix|chave|llave|clave)\b/.test(t);
}

const ESTADOS_CON_OPERACION_EN_CURSO = ["cotizacion_realizada", "aguardando_comprovante"];

// El cliente ya tiene un monto cotizado (y, si aplica, tarjeta) en curso:
// ningún camino del bot debe volver a preguntarle cuánto quiere enviar.
// Solo se retoma una cotización RECIENTE de la conversación actual:
//  - con fecha conocida (fecha_cotizacion/fecha_estado; sin fecha no se
//    retoma -- updated_at no sirve, cambia con cualquier interacción),
//  - de hace 2 h como máximo (mismo criterio que el pedido de PIX), y
//  - del MISMO día en America/Sao_Paulo: una cotización de ayer nunca
//    contamina una conversación nueva, aunque sea de hace minutos (23:50 -> 00:10).
// Recargas quedan fuera (tienen su propio flujo). Esto es solo contexto
// conversacional (customers): una OPERACIÓN real pendiente vive en
// `operations` y no depende de esta función.
const VIGENCIA_COTIZACION_MS = 2 * 60 * 60 * 1000;
function tieneOperacionEnCurso(cliente, ahora = Date.now()) {
    if (!ESTADOS_CON_OPERACION_EN_CURSO.includes(cliente?.estado) || !(Number(cliente?.ultimo_monto) > 0)) return false;
    if (String(cliente?.tipo_favorito || "").startsWith("recarga_")) return false;
    const ref = cliente?.fecha_cotizacion || cliente?.fecha_estado;
    const ts = ref ? new Date(ref).getTime() : NaN;
    if (!Number.isFinite(ts) || ahora - ts > VIGENCIA_COTIZACION_MS) return false;
    return fechaSaoPaulo(new Date(ts)) === fechaSaoPaulo(new Date(ahora));
}

// Detecta respuestas (de la IA) que vuelven a preguntar el monto.
function preguntaElMonto(texto) {
    const t = String(texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return /cuanto (quieres|deseas|vas a|desea|quiere)\s*(enviar|mandar)|que monto|quanto (voce )?(quer|deseja|vai) (enviar|mandar)|qual (o )?valor|dime el monto|me (diz|fala) o valor/.test(t);
}

// PORTÓN ÚNICO DE NEGOCIO — lo que los clasificadores de arriba reconocen
// (o menciona vocabulario inequívoco de remesas/cambio) nunca debe ser
// descartado antes por el filtro de gatillos de openai.js, ni quedar en
// silencio si la IA de respaldo contesta IGNORAR. Así hay UN solo criterio
// en vez de dos vocabularios que se contradicen.
function esMensajeDeNegocio(txt) {
    // Se usa la rama CONCEPTUAL de tasas, no TASAS_FRASES: esa regex
    // histórica tiene subcadenas muy amplias ("a como" coincide con "hola
    // como estas") que, abiertas en el portón, harían responder a saludos.
    if (esConsultaTasasPorConcepto(txt) || esIntencionSinMonto(txt)) return true;
    const c = canonizarIntencion(txt);
    return /\b(remesa|cuba|cup|usd|mlc|dolar|dolares|tasa|cambio|cotizacion)\b/.test(c) ||
        /\b(enviar|mandar|transferir)\b.{0,30}\b(dinero|reales|reais)\b/.test(c);
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

// MONEDA PENDIENTE — cuando el cliente pregunta por la tasa de MLC/USD SIN
// decir cuánto ("tasa del MLC", "cuánto está el USD"), el bot contesta la
// tasa y pregunta "¿cuánto quieres enviar?" (tasaMLC/preguntarCantidadUSD),
// dejando pendiente esa pregunta con el MISMO mecanismo de contexto corto
// que interpretarSeleccionOpcion/interpretarTarjetaPorPalabra (TTL 30 min).
// Si el siguiente mensaje trae un monto pero NO nombra ninguna moneda, se
// asume que sigue hablando de la moneda pendiente -- NUNCA al revés: una
// moneda explícita en ESE mensaje (esMLC/esUSD/esMonedaNacional) siempre
// tiene prioridad y el caller (openai.js) ni siquiera llega a consultar
// esto en ese caso.
function monedaPendienteDeContexto(cliente) {
    if (!contextoUtilizable(cliente)) return null;
    if (cliente?.ultima_pregunta !== "moneda_pendiente") return null;
    const opciones = Array.isArray(cliente?.ultimas_opciones) ? cliente.ultimas_opciones : [];
    return opciones[0] || null;
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

// Placeholders conocidos -- nunca son un nombre real, sin importar
// mayúsculas/minúsculas. Se guardan así en varios flujos (ej.
// agregarOperacion usa "Cliente" quando no se conoce el nombre real) o
// llegan de integraciones/datos sucios.
const PLACEHOLDERS_NOMBRE = new Set([
    "cliente", "fulano", "fulana", "desconocido", "unknown",
    "n/a", "na", "null", "undefined"
]);

// Un componente de nombre humano real: empieza con una letra (con
// acentos/ñ) y de ahí en más solo letras, apóstrofos o guiones --
// O'Connor, Jean-Pierre, María, "De" (de "De la Caridad"). Ningún dígito
// ni símbolo técnico (@, /, :, _, etc.) puede colarse -- eso ya basta para
// descartar teléfonos ("+5351234567", "5351234567") e IDs/códigos, sin
// necesidad de una lista aparte de "cosas que parecen teléfono".
const PATRON_COMPONENTE_NOMBRE = /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'-]*$/;

// Emoji/banderas decorativos en el borde del nombre -- los pushName reales
// de WhatsApp suelen llevarlos ("Ania🍃", "👨 Miguel Ángel"). Se recortan
// SOLO en los bordes (nunca en medio, para no pegar dos palabras) antes de
// evaluar si el resto parece un nombre. Deliberadamente NO incluye
// dígitos, "@" ni "/" -- esos deben seguir tumbando el valor completo
// (teléfonos, emails, IDs), nunca "recortarse" para colar algo inválido.
const EMOJI_BORDE_INICIO = /^[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\s]+/u;
const EMOJI_BORDE_FINAL  = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\s]+$/u;

// Nombre de pila "confiable" para usar en el saludo y en los mensajes de
// recuperación -- nunca se inventa: descarta vacíos, placeholders,
// emails, URLs, teléfonos/IDs y cualquier otro valor sin apariencia
// razonable de nombre humano. Si no hay nada confiable, devuelve null (el
// caller debe entonces saludar/redactar sin nombre, nunca con un valor
// inventado ni con datos técnicos filtrados hacia el cliente).
//
// BUG REAL (producción): un customer tenía guardado un email
// ("livanperezma@gmail.com") como nombre -- el filtro anterior solo
// descartaba vacío y el placeholder "Cliente" exacto, así que ese email
// se colaba tal cual en el saludo/mensaje de recuperación.
//
// Con nombres compuestos (más de una palabra) sigue devolviendo el primer
// componente, igual que antes -- solo si ese primer componente en sí
// mismo es confiable.
function primerNombreConfiable(nombre) {
    const limpio = String(nombre || "").trim();
    if (!limpio) return null;

    // Emails y URLs -- nunca son un nombre, en ningún lugar de la cadena
    // y sin importar mayúsculas/minúsculas.
    if (limpio.includes("@")) return null;
    if (/^https?:\/\//i.test(limpio)) return null;

    if (PLACEHOLDERS_NOMBRE.has(limpio.toLowerCase())) return null;

    const sinEmojiDeBorde = limpio.replace(EMOJI_BORDE_INICIO, "").replace(EMOJI_BORDE_FINAL, "");
    if (!sinEmojiDeBorde) return null;

    const primerComponente = sinEmojiDeBorde.split(/\s+/)[0];
    if (primerComponente.length < 2) return null;
    if (PLACEHOLDERS_NOMBRE.has(primerComponente.toLowerCase())) return null;
    if (!PATRON_COMPONENTE_NOMBRE.test(primerComponente)) return null;

    return primerComponente;
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
    canonizarIntencion,
    esConsultaTasas,
    esIntencionSinMonto,
    esMensajeDeNegocio,
    separarSaludo,
    esConsultaEstadoOperacion,
    esPedidoDePix,
    tieneOperacionEnCurso,
    preguntaElMonto,
    yaAvisoEntregaReciente,
    CONTEXTO_CORTO_TTL_MS,
    contextoCortoVigente,
    contextoUtilizable,
    interpretarSeleccionOpcion,
    interpretarTarjetaPorPalabra,
    monedaPendienteDeContexto,
    esRechazoTarjeta,
    esPausaTemporal,
    esSenalConfusion,
    esCierreNatural,
    esPreguntaExploratoria
};
