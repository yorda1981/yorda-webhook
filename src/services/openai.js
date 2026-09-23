"use strict";

require("dotenv").config();

const { guardarCliente, obtenerCliente, marcarSaludoPendiente, limpiarContextoCorto, limpiarTarjetaFrecuente }          = require("./customer-memory");
const { obtenerUltimaOperacion, obtenerPendienteCliente }                   = require("./operations");
const { activarPausaHumana }                       = require("./webhook-guard");
const crm                                          = require("./crm");
const {
    esTarjetaDuplicada, esConsultaEntrega, esBareMontoValido, esEnvioNuevoSobreAbandonado, puedeCotizarBRL,
    clienteEstaOcupado, tieneContextoReemplazable, esFraseDeAbandonoExplicito,
    debeCompletarConMontoPendiente, debeConfirmarCotizacion, tieneTarjetaGuardada, esConsultaTasas, esIntencionSinMonto, esMensajeDeNegocio, yaAvisoEntregaReciente,
    contextoUtilizable, interpretarSeleccionOpcion, interpretarTarjetaPorPalabra, monedaPendienteDeContexto,
    esRechazoTarjeta, esPausaTemporal, esSenalConfusion, esCierreNatural, esPreguntaExploratoria,
    interpretarAccionRecarga,
    franjaPorHora, franjaSaludoExplicita, primerNombreConfiable
} = require("./reglas-bot");
const { horaSaoPaulo } = require("../utils/timezone");
const { log } = require("../utils/structured-logger");

// Flows
const { detectarImagenUnificada, detectarComprobantePDF, llamarAsistente } = require("../flows/imagen-flow");
const { enviarPIX, _enviarPIXFinal, intentarCompletarOperacion, procesarComprobante, guardarTarjeta } = require("../flows/pix-flow");
const { cotizarBRL, cotizarUSD, preguntarTipoUSD, cotizarMLC, tasaMLC, detectarCUPInverso, cotizarCUPInverso, consultarTasas } = require("../flows/cotizacion-flow");
const { calcularOperacion } = require("./calculator");
const {
    mostrarMenuRecargas, intentarSeleccionDirecta, seleccionarRecarga, procesarNumeroRecarga,
    confirmarResumenRecarga, cambiarModalidadRecarga, cambiarNumeroRecarga
} = require("../flows/recarga-flow");
const {
    enviarSeguro, limpiarSesion, getAdminPhone,
    norm, esPDF, pick, pickL, fmt,
    DOS_HORAS,
    gatilhos, palabrasNegocio, triggersCubaBrasil, confirmaOperacion,
    CONFIRMA_TARJETA_SIN_MONTO, CONFIRMA_TARJETA_SIN_MONTO_PT,
    ESPERA_COMPROBANTE_ES, ESPERA_COMPROBANTE_PT,
    TARJETA_ILEGIBLE,
    getPIXKey
} = require("../flows/shared");

// ─────────────────────────────────────────
// ROUTER PRINCIPAL
// ─────────────────────────────────────────

// Resultado de un mensaje, para observabilidad (ver logResultadoMensaje):
// "respondido" por defecto; los puntos donde el bot se queda en silencio lo
// reportan con su motivo vía opciones.onResultado.
async function procesarMensaje(phone, text, pushName = "", imageUrl = null, opciones = {}) {
    const reportar = (resultado) => { try { opciones?.onResultado?.(resultado); } catch { /* observabilidad nunca rompe el flujo */ } };
    try {
        if (!text || !phone) { reportar("sin_texto"); return ""; }

        const txt = norm(text);

        const cliente    = await obtenerCliente(phone);
        const yaSaludado = !!cliente?.saludo_enviado;

        // ── Idioma y CRM ──
        // FIX 1: usar lang en lugar de esEs para todos los mensajes
        const langDetectado = crm.detectarIdioma(text);
        crm.registrarPrimerContacto(phone, pushName, langDetectado).catch(() => {});
        const langGuardado = cliente?.idioma;
        const lang = langGuardado || langDetectado;
        const esEs = lang !== "pt";   // derivado de lang, no del texto del mensaje
        if (langDetectado && langDetectado !== langGuardado) {
            crm.actualizarEstadoCRM(phone, cliente?.estado_crm || "nuevo_cliente", langDetectado).catch(() => {});
        }

        await guardarCliente({ phone, ultimaInteraccion: new Date().toISOString() });

        // ── Pedido de la calculadora en proceso: el bot se queda en silencio ──
        // Una vez que un pedido llega desde la calculadora, se maneja 100% por el
        // dashboard (VERIFICADO/COMPLETAR) — no hace falta que el bot conversacional
        // intervenga si el cliente manda algo más (ej. la foto del comprobante),
        // porque su estado no tiene la info que el flujo viejo espera (monto,
        // tarjeta, etc.) y podría responder cosas confusas.
        if (cliente?.estado === "pedido_web_pendiente") {
            const m = esEs
                ? "Ya tenemos tu pedido registrado ✅ Lo estamos verificando, te avisamos por aquí en cuanto esté listo."
                : "Já temos seu pedido registrado ✅ Estamos verificando, avisamos por aqui assim que estiver pronto.";
            await enviarSeguro(phone, m);
            return m;
        }

        // ── Horario ──
        const horaBrasil = new Date(Date.now() - 3 * 60 * 60 * 1000).getUTCHours();
        if ((horaBrasil < 8 || horaBrasil >= 23) && !imageUrl) {
            const yaAvisado = cliente?.ultima_interaccion &&
                (Date.now() - new Date(cliente.ultima_interaccion).getTime()) < 60 * 60 * 1000;
            if (!yaAvisado) {
                const msg = esEs
                    ? "Estamos fuera de horario 😊\n\nNuestro horario de atención es de 8am a 11pm (hora de Brasil).\n\nTe responderemos en cuanto estemos disponibles. 👌"
                    : "Estamos fora do horário 😊\n\nNosso horário de atendimento é das 8h às 23h (horário de Brasília).\n\nResponderemos assim que estivermos disponíveis. 👌";
                await enviarSeguro(phone, msg);
                marcarSaludoPendiente(phone).catch(() => {});
            } else {
                reportar("fuera_horario");
            }
            return "";
        }

        // FIX 3: Extraer monto ANTES de esCubaBrasil para que montoValido esté disponible
        const { valorFinal, valorMonetario, montoValido } = extraerMonto(txt, text);
        const soloNums = txt.replace(/\D/g, "");

        // Moneda mencionada EXPLÍCITAMENTE en ESTE mensaje -- se calculan acá
        // (antes solían declararse más abajo, cada uno justo antes de su propio
        // bloque) porque ahora también los necesita la continuidad de MONEDA
        // PENDIENTE de más abajo, para saber cuándo NO debe intervenir (una
        // moneda nombrada en el mensaje actual siempre gana, sin excepción).
        const esMLC = txt.includes("mlc");
        const esUSD = txt.includes("usd") || txt.includes("dolar") || txt.includes("dolares") || txt.includes("dólares");
        const esMonedaNacional = /moneda nacional|en cup\b|a cup\b|pesos cubanos|peso cubano/.test(txt);

        // ── Cuba→Brasil ──
        const esCubaBrasil = triggersCubaBrasil.some(t => txt.includes(norm(t))) ||
            (txt.includes("cup") && !txt.includes("usd") && !txt.includes("dolar") &&
             !txt.includes("real") && !txt.includes("brl") && !txt.includes("recibe") &&
             !txt.includes("enviar") && !txt.includes("mandar") && !txt.includes("quiero") &&
             !txt.includes("quero") && !txt.includes("monto") && !txt.includes("cuanto") &&
             !txt.includes("quanto") && !montoValido);   // ahora montoValido ya existe
        if (esCubaBrasil) {
            const msg = "Perfecto 😊\n\nYordanys te atenderá enseguida para ayudarte con esa operación.\n\nPor favor aguarda un momento. 👌";
            await enviarSeguro(phone, msg); return msg;
        }

        // ── Saludo ──
        const esSaludo = /^(hola|oi|bom dia|buenas|buenos dias|boa tarde|boa noite|buen dia|hey|hi|hello|e ai|eai|buenas tardes|buenas noches|good morning)[\s!?.]*$/.test(txt);
        if (esSaludo) return await manejarSaludo(phone, pushName, cliente, yaSaludado, lang, esEs, txt);

        // ── Filtro de gatillo ──
        const txtTrim = txt.trim();
        const esConfirma = confirmaOperacion.includes(txtTrim) ||
            // FIX: "si por favor", "dale entonces", etc. — antes solo matcheaba exacto
            // contra la lista y quedaban sin respuesta pese a ser confirmaciones claras.
            confirmaOperacion.some(c => txtTrim.startsWith(c + " ")) ||
            /\b(voy a|vou) (mandar|enviar|pagar|transferir)\b/.test(txt) ||
            /\b(te|le) (mando|envio|pago|transfiero)\b/.test(txt);
        const debeResponder = gatilhos.some(g => txt.includes(norm(g))) ||
            palabrasNegocio.some(p => txt.includes(p)) || !!cliente?.estado || !!imageUrl ||
            /^\d+([.,]\d{1,2})?$/.test(txt.trim()) || txt.replace(/\D/g,"").length === 16 || esConfirma ||
            montoValido || // FIX: "400 reales" tras "¿Cuánto deseas enviar?" no tenía estado guardado
                           // ni gatillo, y quedaba sin respuesta pese a ser un monto válido.
            // Portón unificado: lo que los clasificadores reales de reglas-bot.js
            // reconocen (tasas, intención de envío, vocabulario de remesas) nunca
            // se descarta aquí por no estar en la lista de gatillos.
            esMensajeDeNegocio(txt);
        if (!debeResponder) { reportar("porton"); return ""; }

        // ── Abandono explícito de la operación en curso ──
        // "olvida eso"/"cancela eso"/"no era eso"/"otra operación" -- el cliente
        // pide expresamente arrancar de cero. NUNCA toca operations/entregas,
        // solo resetea el contexto conversacional (ver reglas-bot.js). Solo
        // aplica si había algo que abandonar -- si no, no hay nada que hacer
        // y se deja caer al resto del árbol (evita responder a un "cancela eso"
        // suelto de alguien sin ninguna conversación previa).
        if (esFraseDeAbandonoExplicito(txt) && (cliente?.estado || cliente?.comprobante_pendiente)) {
            await limpiarSesion(phone);
            const m = esEs ? "Listo, empezamos de nuevo 😊 ¿Qué necesitas?" : "Pronto, começamos de novo 😊 O que você precisa?";
            await enviarSeguro(phone, m);
            return m;
        }

        // ── Corrección de dato: rechazo de la tarjeta sugerida/guardada ──
        // "esa tarjeta no"/"otra tarjeta" -- corrige SOLO el dato tarjeta, no
        // reinicia toda la operación (a diferencia del abandono explícito de
        // arriba). Solo aplica si de verdad hay una tarjeta que rechazar.
        if (esRechazoTarjeta(txt) && (cliente?.tarjeta_frecuente || cliente?.estado === "seleccionando_tarjeta")) {
            await limpiarTarjetaFrecuente(phone);
            const m = esEs
                ? "Sin problema 😊 ¿Cuál usamos entonces? Mándame la nueva o los 16 dígitos."
                : "Sem problema 😊 Qual usamos então? Manda o novo ou os 16 dígitos.";
            await enviarSeguro(phone, m);
            return m;
        }

        // ── Abandono TEMPORAL ── ("espera"/"todavía no"/"después te mando el
        // comprobante"/"no tengo dinero ahora") -- a diferencia del abandono
        // explícito, NO se toca nada: ni el estado financiero ni el contexto
        // corto. Solo se reconoce brevemente para no sonar insistente.
        if (esPausaTemporal(txt) && (cliente?.estado || cliente?.comprobante_pendiente)) {
            const m = pickL(
                ["Sin problema 😊 Aquí quedo, avísame cuando estés listo.", "Tranquilo, tómate tu tiempo 😊 Te espero."],
                ["Sem problema 😊 Fico por aqui, me avisa quando estiver pronto.", "Tranquilo, sem pressa 😊 Te espero."],
                lang
            );
            await enviarSeguro(phone, m);
            return m;
        }

        // ── Despedida / cierre natural ── ("gracias"/"listo"/"perfecto"/
        // "entendido"/"después te aviso"/"ya pagué, después te aviso") -- van
        // ANTES que "comprobante verbal" más abajo (que si no, respondería
        // "mándame el comprobante" a un cliente que ya avisó que lo manda
        // después). No deben alargar la conversación: si hay un flujo
        // realmente abierto (esperando comprobante), se reconoce breve en
        // vez del cierre genérico.
        if (/^(gracias|ok gracias|hasta luego|chau|tchau|obrigado|obrigada|flw|valeu|até mais)[\s!.]*$/.test(txt.trim()) || esCierreNatural(txt)) {
            if (cliente?.estado === "aguardando_comprovante") {
                const m = esEs ? "¡De nada! 😊 Quedo atento al comprobante 📎" : "De nada! 😊 Fico esperando o comprovante 📎";
                await enviarSeguro(phone, m); return m;
            }
            const n = pushName ? `, ${pushName.split(" ")[0]}` : "";
            const m = `¡Fue un placer${n}! 😊 Gracias por la confianza. Aquí estaremos cuando nos necesites. 👋`;
            await enviarSeguro(phone, m); return m;
        }

        // ── Confusión/frustración ── ("no entendí"/"no fue eso") -- la
        // primera vez se responde más simple; si se repite dentro de los 30
        // min (mismo mecanismo de contexto corto), se ofrece el handoff
        // humano usando la infraestructura ya existente (activarPausaHumana),
        // sin inventar ninguna respuesta nueva.
        if (esSenalConfusion(txt)) {
            const yaHuboConfusionReciente = contextoUtilizable(cliente) && cliente?.ultima_pregunta === "confusion_detectada";
            const intentosPrevios = yaHuboConfusionReciente ? Number(cliente?.ultimas_opciones?.intentos || 1) : 0;
            if (intentosPrevios >= 1) {
                await activarPausaHumana(phone);
                const m = esEs
                    ? "Perdona la confusión 😊 Te conecto directo con Yordanys para resolverlo mejor."
                    : "Desculpa a confusão 😊 Vou te conectar direto com o Yordanys para resolver melhor.";
                await enviarSeguro(phone, m);
                return m;
            }
            await guardarCliente({ phone, ultimaPregunta: "confusion_detectada", ultimasOpciones: { intentos: 1 } });
            const m = esEs
                ? "Perdona, te explico más simple 😊 ¿Cuánto quieres enviar y en qué moneda (reales, dólares o CUP)?"
                : "Desculpa, te explico mais simples 😊 Quanto você quer enviar e em qual moeda (reais, dólares ou CUP)?";
            await enviarSeguro(phone, m);
            return m;
        }

        // ── Derivación humano ──
        if (/yordanys|hablar con alguien|operador|asesor humano|hablar con una persona/.test(txt)) {
            const msg = esEs ? "Yordanys te atiende enseguida 😊 👌" : "Yordanys te atende agora 😊 👌";
            await enviarSeguro(phone, msg); return msg;
        }
        if ((txt.includes("usd") || txt.includes("dolar")) && (txt.includes("real") || txt.includes("brl") || txt.includes("brasil"))) {
            const msg = esEs ? "Eso lo maneja Yordanys directamente 😊 Te atenderá enseguida." : "Isso o Yordanys resolve 😊 Te atende já.";
            await enviarSeguro(phone, msg); return msg;
        }

        // ── Imágenes ──
        if (imageUrl) return await manejarImagen(phone, pushName, cliente, imageUrl, lang, esEs);

        // ── Recargas: selección natural, número, resumen y cambios ──
        // FIX 2: Recarga sube antes de tarjetas — tiene su propio estado y no debe
        // pasar por checks de tarjeta/monto innecesariamente.
        const enFlujoRecarga = cliente?.estado === "seleccionando_recarga" ||
            cliente?.estado === "aguardando_numero_recarga" ||
            cliente?.estado === "confirmando_recarga";

        // Disparador del menú -- si el cliente ya nombra una modalidad puntual
        // ("quiero una recarga internacional") se salta directo a esa opción
        // (ver nombraModalidadRecarga en reglas-bot.js), sin ampliar el
        // gatillo global en sí mismo (sigue siendo el mismo regex de siempre).
        if (/recarga|recargar|recargas|recarga etecsa|recarga cuba|recargar telefono|recarga movil/.test(txt) &&
            cliente?.estado !== "aguardando_comprovante" && !enFlujoRecarga) {
            const directa = await intentarSeleccionDirecta(phone, text);
            if (directa !== null) return directa;
            return await mostrarMenuRecargas(phone);
        }

        if (enFlujoRecarga) {
            // Acciones administrativas del propio flujo (cambiar modalidad/
            // número, cancelar) -- solo dentro del contexto de recarga activo,
            // nunca amplían triggers globales (ver interpretarAccionRecarga en
            // reglas-bot.js).
            const accion = interpretarAccionRecarga(txt);

            if (accion === "cancelar") {
                await limpiarSesion(phone);
                const m = esEs ? "Listo, cancelé la recarga 😊 ¿Necesitas algo más?" : "Pronto, cancelei a recarga 😊 Precisa de mais algo?";
                await enviarSeguro(phone, m);
                return m;
            }
            if (accion === "cambiar_numero" && cliente.estado !== "seleccionando_recarga")
                return await cambiarNumeroRecarga(phone, esEs);
            if (accion === "cambiar_nacional")
                return await cambiarModalidadRecarga(phone, "nacional", esEs);
            if (accion === "cambiar_internacional")
                return await cambiarModalidadRecarga(phone, "internacional", esEs);

            if (cliente.estado === "seleccionando_recarga")
                return await seleccionarRecarga(phone, txt.trim(), esEs);

            if (cliente.estado === "aguardando_numero_recarga")
                return await procesarNumeroRecarga(phone, text, esEs);

            if (cliente.estado === "confirmando_recarga") {
                if (accion === "confirmar" || esConfirma)
                    return await confirmarResumenRecarga(phone, esEs);
                const m = esEs
                    ? "¿Confirmamos la recarga? Responde *sí* para continuar 😊"
                    : "Confirmamos a recarga? Responda *sim* para continuar 😊";
                await enviarSeguro(phone, m);
                return m;
            }
        }

        // ── Selección de tarjeta ──
        // Acepta el número (1, 2...) o una respuesta corta por contexto
        // ("la primera"/"la otra"/"esa") -- ver interpretarSeleccionOpcion en
        // reglas-bot.js. Si es ambiguo, se pregunta -- nunca se adivina.
        if (cliente?.estado === "seleccionando_tarjeta") {
            const tarjetas = Array.isArray(cliente?.tarjetas) ? cliente.tarjetas.filter(t => /^\d{15,16}$/.test(t)) : [];
            let tarjetaElegida = null;
            if (/^[1-9]$/.test(txt.trim())) {
                const idx = parseInt(txt.trim()) - 1;
                if (idx >= 0 && idx < tarjetas.length) tarjetaElegida = tarjetas[idx];
            } else {
                const porContexto = interpretarSeleccionOpcion(txt, cliente);
                if (porContexto === "AMBIGUO") {
                    const m = lang === "pt"
                        ? "Não entendi bem qual cartão -- pode me dizer o número (1, 2...)? 😊"
                        : "No me quedó claro cuál tarjeta -- ¿me dices el número (1, 2...)? 😊";
                    await enviarSeguro(phone, m);
                    return m;
                }
                if (porContexto && tarjetas.includes(porContexto)) tarjetaElegida = porContexto;
            }
            if (tarjetaElegida) {
                await guardarCliente({ phone, tarjeta: tarjetaElegida, tarjeta_frecuente: tarjetaElegida, estado: "aguardando_comprovante", fechaEstado: new Date().toISOString(), fechaPix: new Date().toISOString() });
                await limpiarContextoCorto(phone);
                return await _enviarPIXFinal(phone, await obtenerCliente(phone), esEs);
            }
        }

        // ── Confirmación de reutilizar la tarjeta frecuente ──
        // Respuesta a "¿Usamos nuevamente la tarjeta terminada en XXXX?" (ver
        // enviarPIX en pix-flow.js). "sí/dale/ok" -> se reutiliza y se llama
        // directo a _enviarPIXFinal (no a enviarPIX, para no volver a
        // preguntar). Se limpia el contexto ANTES de seguir para que una
        // futura operación con la misma tarjeta sí vuelva a confirmar.
        // Rechazo ya se maneja arriba (esRechazoTarjeta); este bloque cubre
        // el "sí".
        if (contextoUtilizable(cliente) && cliente?.ultima_pregunta === "confirmar_tarjeta_frecuente" && esConfirma) {
            await limpiarContextoCorto(phone);
            return await _enviarPIXFinal(phone, await obtenerCliente(phone), esEs);
        }

        // ── Selección tipo (comprobante sin tipo) ──
        if (cliente?.comprobante_pendiente && !cliente?.tipo_favorito && /^[123]$/.test(txt.trim())) {
            await guardarCliente({ phone, tipo: { "1": "brl_cup", "2": "usd_clasica", "3": "usd_prepago" }[txt.trim()] });
            await intentarCompletarOperacion(phone, pushName, await obtenerCliente(phone), esEs);
            return "";
        }

        // ── Selección Clásica/Prepago USD ──
        if (cliente?.tipo_favorito === "usd_pendiente_tipo" && /^[12]$/.test(txt.trim())) {
            const tipoUSD = txt.trim() === "1" ? "usd_clasica" : "usd_prepago";
            const montoG  = Number(cliente?.ultimo_monto);
            if (montoG > 0) return await cotizarUSD(phone, pushName, montoG, tipoUSD, lang, esEs) || "";
        }

        // ── FIX LOOP (parte 2): comprobante + tarjeta ya recibidos, solo faltaba el monto ──
        // El cliente responde el monto → cerrar la operación directamente (NO cotizar de nuevo).
        // Lógica en src/services/reglas-bot.js (probada en test/reglas-bot.test.js)
        if (debeCompletarConMontoPendiente(cliente, montoValido, text)) {
            await guardarCliente({ phone, monto: valorFinal, tipo: cliente.tipo_favorito || "brl_cup" });
            await intentarCompletarOperacion(phone, pushName, await obtenerCliente(phone), esEs);
            return "";
        }

        // ── Tarjeta por texto ──
        // "tarjeta" como palabra suelta reutiliza la tarjeta frecuente ya
        // guardada, SOLO si el bot estaba esperando justo eso (ver
        // interpretarTarjetaPorPalabra en reglas-bot.js) -- nunca adivina
        // cuál si no hay contexto vigente o si no hay ninguna guardada.
        const esTarjeta = detectarTarjetaTexto(text) || interpretarTarjetaPorPalabra(txt, cliente);
        if (esTarjeta) {
            await limpiarContextoCorto(phone);
            // FIX MENSAJE DUPLICADO: si esta MISMA tarjeta ya estaba guardada y ya estamos
            // esperando el comprobante, no hay nada nuevo que hacer — evita reenviar el PIX
            // completo cada vez que el cliente manda otro mensaje con el mismo número
            // (ej. lo pega 2-3 veces seguidas por error).
            // Lógica en src/services/reglas-bot.js (probada en test/reglas-bot.test.js)
            if (esTarjetaDuplicada(cliente, esTarjeta)) {
                const m = lang === "pt" ? "Já tenho esse cartão salvo ✅ Só falta o comprovante 📎" : "Ya tengo esa tarjeta guardada ✅ Solo falta el comprobante 📎";
                await enviarSeguro(phone, m);
                return m;
            }

            await guardarTarjeta(phone, esTarjeta, null, null, cliente);
            const cli2 = await obtenerCliente(phone);
            if (cli2.comprobante_pendiente) {
                // FIX LOOP: si no se puede completar (falta el monto), intentarCompletarOperacion
                // ya pidió el dato que falta. NO seguir al reenvío de PIX.
                await intentarCompletarOperacion(phone, pushName, cli2, esEs);
                return "";
            }
            if (cli2.ultimo_monto && Number(cli2.ultimo_monto) > 0) {
                await guardarCliente({ phone, estado: "aguardando_comprovante", fechaEstado: new Date().toISOString(), fechaPix: new Date().toISOString() });
                // FIX: el cliente ya indicó la tarjeta en ESTE mensaje (texto) — no hay que
                // volver a preguntar cuál usar aunque tenga varias guardadas de antes.
                const montoPago = await montoPagoEnReales(cli2);
                const m = lang === "pt" ? `Cartão salvo! 💳\n\nVou te mandar o PIX para pagar R$${fmt(montoPago)} 👇` : `¡Tarjeta guardada! 💳\n\nTe envío el PIX para pagar R$${fmt(montoPago)} 👇`;
                await enviarSeguro(phone, m);
                return await _enviarPIXFinal(phone, cli2, esEs);
            }
            const m = pickL(CONFIRMA_TARJETA_SIN_MONTO, CONFIRMA_TARJETA_SIN_MONTO_PT, lang);
            await enviarSeguro(phone, m); return m;
        }

        // ── Consulta sobre entrega en efectivo / municipio ──
        // Cliente pregunta por el proceso de entrega física (no está pidiendo cotización
        // todavía) — explicación breve + link de la calculadora para que haga el pedido solo.
        // Lógica en src/services/reglas-bot.js (probada en test/reglas-bot.test.js)
        if (esConsultaEntrega(txt, montoValido, cliente)) {
            const link = "https://yorda-webhook-production.up.railway.app/calculadora.html";
            let m;
            if (yaAvisoEntregaReciente(cliente)) {
                // Ya se le mandó la explicación completa hace poco — no la repetimos entera.
                m = lang === "pt"
                    ? `Como te disse, entregamos direto no município sede — outros municípios a gente confirma por aqui. Para fazer o pedido: 👇\n${link}`
                    : `Como te comenté, entregamos directo en el municipio cabecera — otros municipios los confirmamos por aquí. Para hacer el pedido: 👇\n${link}`;
            } else {
                // Dos redacciones con la MISMA información (tiempos, costos, link) --
                // solo cambia qué tan detallado suena, para variar el primer contacto
                // sin perder ningún dato importante.
                m = lang === "pt"
                    ? pick([
                        `🚚 *Entrega em dinheiro em Cuba*\n\nEntregamos direto no município sede das 16 províncias. Se for outro município, confirmamos disponibilidade por aqui mesmo.\n\n⏱️ Havana: até 24h · Demais províncias: até 48h (conforme demanda)\n\n💰 O custo da entrega é somado à parte — nunca é descontado do que seu familiar recebe.\n\nPara calcular o valor exato e fazer o pedido passo a passo, entra aqui 👇\n${link}`,
                        `🚚 Entregamos em dinheiro direto no município sede (⏱️ até 24h em Havana, até 48h nas demais). O custo é somado à parte, nunca descontado do que seu familiar recebe.\n\nPara calcular o valor e pedir 👇\n${link}`
                    ])
                    : pick([
                        `🚚 *Entrega en efectivo en Cuba*\n\nEntregamos directo en el municipio cabecera de las 16 provincias. Si es otro municipio, confirmamos disponibilidad por aquí mismo.\n\n⏱️ La Habana: hasta 24h · Resto de provincias: hasta 48h (según demanda)\n\n💰 El costo de entrega se suma aparte — nunca se descuenta de lo que recibe tu familiar.\n\nPara calcular el monto exacto y hacer el pedido paso a paso, entra aquí 👇\n${link}`,
                        `🚚 Entregamos en efectivo directo en el municipio cabecera (⏱️ hasta 24h en La Habana, hasta 48h en el resto). El costo se suma aparte, nunca se descuenta de lo que recibe tu familiar.\n\nPara calcular el monto y hacer el pedido 👇\n${link}`
                    ]);
            }
            await guardarCliente({ phone, ultimoAvisoEntrega: new Date().toISOString() });
            await enviarSeguro(phone, m);
            return m;
        }

        // ── QR ilegible ──
        if (/qr|codigo qr|no puedo escanear|no leo el qr|no consigo escanear/.test(txt)) {
            const key = getPIXKey();
            const m   = key ? `No hay problema 😊\n\nCopia la clave PIX:\n\n${key}` : "Pídele la clave directamente a Yordanys 😊";
            await enviarSeguro(phone, m); return m;
        }

        // ── Continuidad de cotización inversa CUP → BRL ──
        // Si la última pregunta del bot fue "¿cuánto pago para que lleguen X
        // CUP?" y el contexto corto sigue vigente (< 30 min), un número nuevo
        // suelto (con o sin "mejor"/"que sean" delante) sustituye el OBJETIVO
        // EN CUP anterior -- NUNCA se interpreta como un monto nuevo a enviar
        // en reales. Va ANTES del bloque de "número suelto = monto BRL" de
        // abajo, que si corriera primero cotizaría el número como reales.
        if (contextoUtilizable(cliente) && cliente?.ultima_pregunta === "cotizacion_inversa_pendiente") {
            const soloNumero = txt.replace(/^(mejor|que sean|seria|seriam|melhor|prefiro)\s+/, "").trim();
            const nuevoCupObjetivo = /^\d{3,7}$/.test(soloNumero) ? Number(soloNumero) : null;
            if (nuevoCupObjetivo && nuevoCupObjetivo >= 1000 && nuevoCupObjetivo <= 5000000) {
                const r = await cotizarCUPInverso(phone, pushName, nuevoCupObjetivo, lang);
                if (r) return r;
            }
        }

        // FIX 4 (revisado): Número solo → tratar como monto y cotizar
        // ANTES: exigía montoValido, pero un número aislado como "200" (sin "reales" ni
        // "enviar" junto) nunca activa montoValido, así que el bloque nunca disparaba y
        // el mensaje quedaba sin respuesta. Ahora se calcula el número directo del texto.
        // Lógica en src/services/reglas-bot.js (probada en test/reglas-bot.test.js)
        // (se calcula ACÁ, antes de la continuidad de moneda pendiente de abajo,
        // porque esta también necesita reconocer un número suelto como "1000").
        const bareNumero = esBareMontoValido(txt);

        // ── Continuidad de MONEDA PENDIENTE (MLC/USD preguntado sin monto) ──
        // BUG REAL (producción): cliente pregunta "tasa del MLC" (sin monto) ->
        // tasaMLC() contesta la tasa y pregunta "¿cuánto quieres enviar?", pero
        // antes NO guardaba ningún estado -- así que un "1000 reales" (o un "1000"
        // suelto) en el siguiente mensaje no tenía cómo saber que seguía hablando
        // de MLC y caía al flujo por defecto (BRL→CUP), cotizando la moneda
        // equivocada. Mismo defecto en preguntarCantidadUSD() (USD sin monto).
        //
        // Fix: tasaMLC/preguntarCantidadUSD ahora dejan la pregunta pendiente con
        // el mecanismo de contexto corto ya existente (ultima_pregunta =
        // "moneda_pendiente", TTL 30 min -- ver reglas-bot.js:
        // monedaPendienteDeContexto). Si este mensaje trae un monto (con palabra
        // de moneda o número suelto) y NO nombra ninguna moneda explícita
        // (esMLC/esUSD/esMonedaNacional, calculados arriba), se respeta la moneda
        // pendiente. Una moneda explícita en ESTE mensaje SIEMPRE gana -- por eso
        // el guard exige que las tres sean false antes de siquiera consultar el
        // contexto pendiente (NUEVA INTENCIÓN EXPLÍCITA > CONTEXTO ANTERIOR, sin
        // excepciones).
        const montoParaContinuidad = montoValido ? valorFinal : bareNumero;
        if (!esMLC && !esUSD && !esMonedaNacional && montoParaContinuidad !== null) {
            const monedaPendiente = monedaPendienteDeContexto(cliente);
            if (monedaPendiente === "mlc") return await cotizarMLC(phone, pushName, montoParaContinuidad, lang) || "";
            if (monedaPendiente && monedaPendiente.startsWith("usd"))
                return await cotizarUSD(phone, pushName, montoParaContinuidad, monedaPendiente, lang, esEs) || "";
        }

        if (bareNumero !== null) {
            if (!clienteEstaOcupado(cliente)) return await cotizarBRL(phone, pushName, bareNumero, lang) || "";
        }

        // FIX 5: Confirmación — verificar que NO hay monto nuevo en el mensaje
        // "quiero 200 reales" no debe confirmar, debe cotizar
        // Lógica en src/services/reglas-bot.js (probada en test/reglas-bot.test.js)
        if (debeConfirmarCotizacion(cliente, esConfirma, montoValido)) {
            if (!tieneTarjetaGuardada(cliente)) {
                await enviarSeguro(phone, pickL(
                    ["¡Casi listo! Solo necesito la tarjeta 💳\n\nMándame foto o los 16 dígitos."],
                    ["Quase lá! Só preciso do cartão 💳\n\nManda uma foto ou os 16 dígitos."], lang));
                return "";
            }
            await guardarCliente({ phone, estado: "aguardando_comprovante", fechaEstado: new Date().toISOString(), fechaPix: new Date().toISOString() });
            return await enviarPIX(phone, cliente, esEs);
        }

        // ── PIX directo ──
        const quierePagar =
            /^(pix|pasame (el )?pix|enviame (el )?pix|manda(me)? (el )?pix|envia(me)? (el )?pix|quiero (pagar|hacerlo)|voy a pagar|fazer pix|hacer pix|manda pix|envia pix|send pix|chave pix|llave pix|qual (o|a) pix|cual (es )?(el|la) (llave|chave|clave) pix|me manda(s)? (el|o) pix|me pasa(s)? el pix|pode (me )?mandar o pix|envia o pix)$/.test(txt.trim()) ||
            /\b(quiero|voy a) (hacer|enviar|mandar)( el)? pix\b/.test(txt) ||
            /\bvoy a pagar\b/.test(txt) ||
            /\b(llave|chave|clave)\b.{0,15}\bpix\b/.test(txt) ||
            /\b(quiero|quero|vou)\s+pagar\b/.test(txt);

        if (quierePagar) {
            const ref = cliente?.fecha_cotizacion || cliente?.updated_at;
            if (ref && Date.now() - new Date(ref).getTime() > DOS_HORAS) {
                await enviarSeguro(phone, esEs ? "La cotización venció ⏰\n\nDime el monto de nuevo y te actualizo la tasa." : "A cotação expirou ⏰\n\nMe diz o valor de novo.");
                return "";
            }
            if (!cliente?.ultimo_monto || Number(cliente.ultimo_monto) <= 0) {
                const m2 = txt.match(/\b(\d{2,5})\b/);
                const mp = m2 ? Number(m2[1]) : null;
                if (mp && mp >= 10) {
                    await guardarCliente({ phone, nombre: pushName, monto: mp, tipo: "brl_cup", estado: "aguardando_comprovante", fechaEstado: new Date().toISOString(), fechaPix: new Date().toISOString(), fechaCotizacion: new Date().toISOString() });
                    return await enviarPIX(phone, await obtenerCliente(phone), esEs);
                }
            }
            return await enviarPIX(phone, cliente, esEs);
        }

        // ── Comprobante verbal ──
        if (/paguei|pague|comprovante|comprobante|feito|realizado|ya envie|ya mande|ya pague|hice el pago/.test(txt)) {
            await enviarSeguro(phone, esEs ? "¡Perfecto! Mándame el comprobante (foto o PDF) 📎" : "Ótimo! Me manda o comprovante (foto ou PDF) 📎");
            return "";
        }

        // ── MLC ──
        if (esMLC && montoValido) return await cotizarMLC(phone, pushName, valorFinal, lang) || "";
        if (esMLC)                return await tasaMLC(phone, lang) || "";

        // ── CUP inverso ──
        const cupInv = detectarCUPInverso(txt);
        if (cupInv) { const r = await cotizarCUPInverso(phone, pushName, cupInv, lang); if (r) return r; }

        // ── Consulta tasas ──
        // Lógica en src/services/reglas-bot.js (probada en test/reglas-bot.test.js)
        if (esConsultaTasas(txt))
            return await consultarTasas(phone) || "";

        // ── Cliente EXPLORANDO (no decidido todavía) ──
        // "¿cómo funciona?"/"qué opciones tienen?"/"¿cuánto sería?" -- explica
        // y cotiza (vía la misma consulta de tasas determinista) SIN empujarlo
        // a dar tarjeta o pagar. No cambia ninguna regla financiera: es la
        // misma información que consultarTasas(), solo que aquí también se
        // dispara para frases que hoy no matchean esConsultaTasas().
        if (esPreguntaExploratoria(txt)) {
            const t = await consultarTasas(phone);
            if (t) return t;
        }

        // ── Estado de operación ──
        if (/estado|mi operacion|mi envio|cuando llega|cuando llego|cuanto falta|ya llego|esta listo/.test(txt)) {
            const ultima = await obtenerUltimaOperacion(phone);
            if (!ultima) { await enviarSeguro(phone, "No encuentro operaciones registradas 🤔\n\n¿Quieres hacer un envío?"); return ""; }
            const estadoTxt = ultima.status === "completada" ? "🎉 Completada"
                : ultima.status === "confirmada" ? "✅ Confirmada, en proceso"
                : "⏳ Pendiente de verificar";
            await enviarSeguro(phone, `Tu última operación: R$${ultima.monto} — ${estadoTxt}`);
            return "";
        }

        // ── USD ──
        if (esUSD && !txt.includes("real") && !txt.includes("brl")) {
            if (!montoValido) return await preguntarCantidadUSD(phone, txt, lang, esEs) || "";

            // FIX: pedir explícitamente una operación en USD mientras había una
            // tarjeta/comprobante_pendiente de un contexto viejo reemplazable
            // (ver ESTADOS_REEMPLAZABLES en reglas-bot.js) es siempre una
            // intención nueva -- cambiar de moneda de origen ya es suficiente
            // señal, no hace falta comparar montos. Se limpia la sesión vieja
            // ANTES de cotizar para que esos datos no se arrastren a esta
            // operación nueva. Mismo criterio de seguridad que el flujo BRL:
            // nunca se pisa si ya existe una operación real pendiente.
            if (tieneContextoReemplazable(cliente)) {
                const hayOperacionReal = cliente?.comprobante_pendiente ? !!(await obtenerPendienteCliente(phone)) : false;
                if (!hayOperacionReal) await limpiarSesion(phone);
            }

            const esEfectivo = /efectivo|cash|vender|cambiar|comprar/.test(txt);
            const esPrepago  = /prepago|nauta|internacional/.test(txt);
            const esClasica  = /clasica|clásica|bpa|bandec|metropolitano/.test(txt);
            if (!esEfectivo && !esPrepago && !esClasica) return await cotizarUSD(phone, pushName, valorFinal, "usd_clasica", lang, esEs) || "";
            return await cotizarUSD(phone, pushName, valorFinal, esEfectivo ? "usd_efectivo" : esPrepago ? "usd_prepago" : "usd_clasica", lang, esEs) || "";
        }

        // FIX 6: BRL→CUP — NO disparar si el cliente está esperando comprobante
        // Un cliente en aguardando_comprovante que manda un número no debe recibir cotización
        const estadoBloquea    = clienteEstaOcupado(cliente);
        const hayContextoBRL   = valorMonetario !== null ||
            (!estadoBloquea && !!cliente?.estado) ||
            /enviar|mandar|envio|cotiz|transfer|pagar|monto|quant|cuant|quanto|quiero|mejor|eran/.test(txt) ||
            esMonedaNacional;

        // FIX ENVÍO NUEVO SOBRE UNO ABANDONADO: si el cliente quedó "esperando comprobante"
        // de una operación vieja que nunca completó, y ahora escribe un monto DISTINTO,
        // es un envío nuevo — no la misma operación. Limpiamos la sesión vieja (tarjeta,
        // estado) para que no reaparezca la operación anterior en vez de cotizar la nueva.
        // Lógica en src/services/reglas-bot.js (probada en test/reglas-bot.test.js)
        // hayOperacionReal solo se consulta cuando de verdad importa (contexto
        // reemplazable + comprobante_pendiente) -- evita una query extra en el
        // resto de los mensajes.
        const hayOperacionRealBRL = (tieneContextoReemplazable(cliente) && cliente?.comprobante_pendiente)
            ? !!(await obtenerPendienteCliente(phone))
            : false;
        if (esEnvioNuevoSobreAbandonado(cliente, montoValido, valorFinal, hayOperacionRealBRL)) await limpiarSesion(phone);

        if (hayContextoBRL && !esUSD && !esMLC && puedeCotizarBRL(cliente, montoValido, valorFinal, hayOperacionRealBRL))
            return await cotizarBRL(phone, pushName, valorFinal, lang) || "";

        if (valorFinal && !montoValido) { reportar("monto_invalido"); return ""; }

        // ── Cuba sin monto ──
        if (txt.includes("cuba") && (/dinero|dinheiro|enviar|mandar|pasar|passar|plata|remesa|remessa/.test(txt) || esIntencionSinMonto(txt))) {
            const n = pushName ? `, ${pushName.split(" ")[0]}` : "";
            await enviarSeguro(phone, `¡Hola${n}! 😊\n\n¿Cuánto quieres enviar a Cuba?`); return "";
        }

        // ── Intención sin monto ──
        // Lógica en src/services/reglas-bot.js (probada en test/reglas-bot.test.js)
        if (esIntencionSinMonto(txt)) {
            const m = esEs ? "Perfecto 😊\n\n¿Cuánto deseas enviar?" : "Perfeito 😊\n\nQuanto você quer enviar?";
            await enviarSeguro(phone, m); return "";
        }

        // ── Cierre inteligente ──
        if (Number(cliente?.ultimo_monto) > 0 && !!(cliente?.tarjeta || cliente?.tarjeta_frecuente)) {
            if (/mismo|misma|llave|chave|transferir|depositar|proceder|continuar|reales|real|brl|r\$|envio el dinero|voy a pagar|quiero pagar/.test(txt)) {
                await guardarCliente({ phone, estado: "aguardando_comprovante", fechaEstado: new Date().toISOString(), fechaPix: new Date().toISOString() });
                return await enviarPIX(phone, cliente, esEs);
            }
        }

        // ── Asistente GPT fallback ──
        const palabras = txt.trim().split(/\s+/);
        if (palabras.length < 4 || /^\d+$/.test(txt.trim())) { reportar("fallback_corto"); return ""; }
        let motivoSilencio = "ia_vacio";
        try {
            // FIX SESIÓN VIEJA: si la última interacción fue hace más de 2 horas, no
            // encadenar el hilo de GPT anterior — si no, un cliente que vuelve días
            // después arrastra el contexto de una consulta vieja aunque diga otro valor.
            const hiloVencido = cliente?.ultima_interaccion &&
                (Date.now() - new Date(cliente.ultima_interaccion).getTime()) > DOS_HORAS;
            const { texto, responseId } = await llamarAsistente(text, hiloVencido ? null : cliente?.last_response_id);
            const esIgnorar = /^ignorar[.!]?$/i.test(texto.trim()) || /silencio total/i.test(texto);
            if (texto && texto.trim() && !esIgnorar) {
                await guardarCliente({ phone, lastResponseId: responseId });
                await enviarSeguro(phone, texto);
                return texto;
            }
            motivoSilencio = esIgnorar ? "ia_ignorar" : "ia_vacio";
        } catch (e) { console.error("❌ Asistente:", e.message); motivoSilencio = "ia_error"; }

        // ── Red de seguridad del fallback ──
        // Un mensaje claramente de negocio (remesas, Cuba, cambio/tasas,
        // CUP/USD/MLC, intención de enviar) no queda en silencio solo porque la
        // IA contestó IGNORAR/vacío o falló. Respuesta fija: no cita tasas,
        // montos ni disponibilidad, y no inicia ninguna operación -- solo
        // reencamina a los flujos deterministas (tasa del día o monto).
        if (esMensajeDeNegocio(txt)) {
            const m = esEs
                ? "Claro, te ayudo con eso 😊 ¿Quieres saber la tasa de hoy o ya tienes el monto que deseas enviar?"
                : "Claro, te ajudo com isso 😊 Quer saber a taxa de hoje ou já tem o valor que deseja enviar?";
            await enviarSeguro(phone, m);
            reportar(`respondido_rescate_${motivoSilencio}`);
            return m;
        }
        reportar(motivoSilencio);

    } catch (e) { console.error("❌ procesarMensaje:", e.message); reportar("error"); }
    return "";
}

// Una línea de log por mensaje de texto procesado, distinguiendo lo que se
// respondió de lo que quedó en silencio y por qué (portón, IA IGNORAR, IA
// vacía/error...). Solo teléfono enmascarado y el motivo -- nunca el texto.
function logResultadoMensaje(phone, resultado = "respondido") {
    if (String(resultado).startsWith("respondido")) log("MESSAGE_PROCESSED", { phone, resultado });
    else log("MESSAGE_DISCARDED", { phone, motivo: resultado });
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

// FIX MONEDA: para operaciones USD/MLC, ultimo_monto está en la moneda original
// (USD o MLC), NO en reales. Este helper recalcula el monto real a pagar en R$.
async function montoPagoEnReales(cliente) {
    const tipoOp = cliente.tipo_favorito || "brl_cup";
    if (tipoOp === "brl_cup") return Number(cliente.ultimo_monto);
    const r = await calcularOperacion({ tipo: tipoOp, valor: cliente.ultimo_monto });
    return r ? r.cup : Number(cliente.ultimo_monto);
}

function extraerMonto(txt, text) {
    // REGLA DURA: un número atado explícitamente a CUP/pesos cubanos es el
    // DESTINO (lo que recibe el familiar), nunca el ORIGEN (lo que el
    // cliente envía). Antes "cup" vivía en la MISMA lista que "reales"/"brl"/
    // "usd", así que un mensaje como "necesito enviar 30000 cup" terminaba
    // cotizándose como si el cliente quisiera ENVIAR R$30.000. Ahora se
    // separan en dos regex: MONTO_ORIGEN (monedas que sí se envían) y
    // MONTO_CUP (monto de destino) -- un match de MONTO_CUP nunca produce un
    // valorMonetario ni entra al fallback de "número suelto".
    const MONTO_ORIGEN = /(?:r\$|reais|reales|real|brl|usd|d[oó]lar(?:es)?|mlc|plata|dinero)\s*(\d{2,5})|\b(\d{2,5})\s*(?:r\$|reais|reales|real|brl|usd|d[oó]lar(?:es)?|mlc)/i;
    const MONTO_CUP    = /(?:cup|cuc|pesos?\s*cubanos?|peso\s*cubano)\s*(\d{2,5})|\b(\d{2,5})\s*(?:cup|cuc|pesos?\s*cubanos?)/i;

    const matchMonetario  = text.match(MONTO_ORIGEN);
    const matchCup        = text.match(MONTO_CUP);
    const valorMonetario  = matchMonetario ? Number(matchMonetario[1] || matchMonetario[2]) : null;

    // Si el único número presente está atado a CUP y no hay ninguna moneda de
    // origen explícita en el mismo mensaje, ni siquiera el fallback de
    // "número suelto junto a una palabra de intención" puede usarlo.
    const soloTieneCUP = !valorMonetario && !!matchCup;

    // "mejor"/"eran" habilitan corregir un monto ya cotizado ("mejor 500",
    // "no, eran 700") sin necesitar además una palabra de envío -- ver
    // esEnvioNuevoSobreAbandonado en reglas-bot.js, que decide si el nuevo
    // monto reemplaza al viejo.
    let valorContextual = null;
    if (!valorMonetario && !soloTieneCUP && /enviar|mandar|envio|cotiz|transfer|pagar|monto|quant|cuant|quanto|quiero|mejor|eran/.test(txt)) {
        const mc = /\b(\d{2,5})\b/g;
        let m;
        while ((m = mc.exec(txt)) !== null) { const n = Number(m[1]); if (n >= 10 && n <= 50000) { valorContextual = n; break; } }
    }
    const valorFinal  = valorMonetario || valorContextual || null;
    const montoValido = !!(valorFinal && valorFinal >= 10 && valorFinal <= 50000);
    return { valorFinal, valorMonetario, montoValido };
}

function detectarTarjetaTexto(text) {
    const rawTrim = text.trim();
    if (!/^[\d\s\-]+$/.test(rawTrim)) return false;
    const digits = rawTrim.replace(/[\s\-]/g, "");
    if (!/^\d{15,16}$/.test(digits)) return false;
    if (/^55\d{10,11}$/.test(digits)) return false;
    return digits;
}

// ─────────────────────────────────────────
// PLANTILLAS DE SALUDO — deterministas (conjunto fijo + pick(), nunca IA
// libre), separadas por: cliente frecuente / cliente registrado (no
// frecuente) / cliente nuevo, y por franja horaria dentro de cada uno
// (salvo "frecuente", que mantiene exactamente las mismas 2 variantes que
// ya tenía antes de esta fase -- no se tocó, no fue parte de lo pedido).
//
// Cada plantilla es (sufijoNombre) => texto -- `sufijoNombre` ya viene
// formateado (", Lourdes" en ES / " Lourdes" en PT) o "" si no hay nombre
// confiable, nunca "undefined"/"null" interpolado.
// ─────────────────────────────────────────

const SALUDO_FRECUENTE = {
    es: [
        (n) => `¡Hola${n}! Qué bueno verte de nuevo 😊 ¿En qué te ayudo hoy?`,
        (n) => `¡Hola${n}! Siempre un placer 😊 ¿Qué necesitas?`
    ],
    pt: [
        (n) => `Oi${n}! Que bom te ver de novo 😊 Em que posso te ajudar hoje?`,
        (n) => `Olá${n}! Sempre bom contar com você 😊 O que precisa hoje?`
    ]
};

// Cliente registrado (existe en `customers`) pero no frecuente -- se le
// saluda por su nombre (si es confiable) y se asume que probablemente
// quiere enviar, ya que es alguien que ya interactuó antes.
const SALUDO_REGISTRADO = {
    es: {
        manana: [
            (n) => `¡Buenos días${n}! 😊 Qué gusto saludarte. ¿Cuánto quieres enviar hoy?`,
            (n) => `¡Hola${n}, buenos días! ☀️ ¿Cuánto quieres enviar hoy?`,
            (n) => `Buenos días${n} 👋 ¿Cómo estás? ¿Cuánto deseas enviar?`
        ],
        tarde: [
            (n) => `Buenas tardes${n} 👋😊 ¿Cómo estás? ¿Cuánto deseas enviar?`,
            (n) => `¡Hola${n}! Buenas tardes 🌤️ ¿Cuánto quieres enviar hoy?`,
            (n) => `Buenas tardes${n} 😊 Qué gusto saludarte. ¿Qué necesitas?`
        ],
        noche: [
            (n) => `¡Buenas noches${n}! 🌙 Qué gusto tenerte por aquí. ¿Qué deseas hacer?`,
            (n) => `Buenas noches${n} 😊 ¿En qué te ayudo?`,
            (n) => `¡Hola${n}! Buenas noches 🌙 ¿Qué necesitas?`
        ]
    },
    pt: {
        manana: [
            (n) => `Bom dia${n}! 😊 Que bom te saudar. Quanto quer enviar hoje?`,
            (n) => `Olá${n}, bom dia! ☀️ Quanto quer enviar hoje?`,
            (n) => `Bom dia${n} 👋 Como você está? Quanto deseja enviar?`
        ],
        tarde: [
            (n) => `Boa tarde${n} 👋😊 Como você está? Quanto deseja enviar?`,
            (n) => `Oi${n}! Boa tarde 🌤️ Quanto quer enviar hoje?`,
            (n) => `Boa tarde${n} 😊 Que bom te saudar. O que precisa?`
        ],
        noche: [
            (n) => `Boa noite${n}! 🌙 Que bom ter você por aqui. O que deseja fazer?`,
            (n) => `Boa noite${n} 😊 Em que posso ajudar?`,
            (n) => `Oi${n}! Boa noite 🌙 O que precisa?`
        ]
    }
};

// Cliente nuevo (nunca escribió antes, `cliente` no existe en `customers`)
// -- NUNCA se asume que quiere enviar dinero, ni se inventa un nombre.
const SALUDO_NUEVO = {
    es: {
        manana: [
            () => `¡Buenos días! 😊 Bienvenido a Yorda Envíos. ¿En qué podemos ayudarte?`,
            () => `Buenos días 👋 Gracias por escribirnos. ¿Qué deseas hacer?`
        ],
        tarde: [
            () => `¡Buenas tardes! 😊 Bienvenido a Yorda Envíos. ¿En qué podemos ayudarte?`,
            () => `Hola 👋😊 Buenas tardes. Gracias por escribirnos. ¿Qué deseas hacer?`
        ],
        noche: [
            () => `¡Buenas noches! 😊 Bienvenido a Yorda Envíos. ¿En qué podemos ayudarte?`,
            () => `Hola 👋 Buenas noches. Gracias por escribirnos. ¿Qué deseas hacer?`
        ]
    },
    pt: {
        manana: [
            () => `Bom dia! 😊 Bem-vindo à Yorda Envíos. Em que podemos ajudar?`,
            () => `Bom dia 👋 Obrigado por escrever. O que deseja fazer?`
        ],
        tarde: [
            () => `Boa tarde! 😊 Bem-vindo à Yorda Envíos. Em que podemos ajudar?`,
            () => `Oi 👋😊 Boa tarde. Obrigado por escrever. O que deseja fazer?`
        ],
        noche: [
            () => `Boa noite! 😊 Bem-vindo à Yorda Envíos. Em que podemos ajudar?`,
            () => `Oi 👋 Boa noite. Obrigado por escrever. O que deseja fazer?`
        ]
    }
};

// Función pura (exportada para pruebas automáticas) -- dado el contexto ya
// decidido por el caller (nunca decide ella misma si corresponde saludar),
// arma el texto final. `nombre` ya viene filtrado por primerNombreConfiable
// -- null/"" nunca se interpola.
function construirSaludo({ lang, esRegistrado, frecuente, nombre, franja }) {
    const idioma = lang === "pt" ? "pt" : "es";
    const sufijoNombre = nombre ? (idioma === "pt" ? ` ${nombre}` : `, ${nombre}`) : "";

    let plantillas;
    if (frecuente) plantillas = SALUDO_FRECUENTE[idioma];
    else if (esRegistrado) plantillas = SALUDO_REGISTRADO[idioma][franja] || SALUDO_REGISTRADO[idioma].tarde;
    else plantillas = SALUDO_NUEVO[idioma][franja] || SALUDO_NUEVO[idioma].tarde;

    return pick(plantillas)(sufijoNombre);
}

async function manejarSaludo(phone, pushName, cliente, yaSaludado, lang, esEs, txt = "") {
    if (!yaSaludado) {
        // "Registrado" = existe una fila en `customers` para este teléfono
        // (ya escribió antes), sin importar si tiene operaciones reales --
        // eso es "frecuente", un caso más específico dentro de "registrado".
        const esRegistrado = !!cliente;
        const frecuente = !!cliente?.cliente_frecuente;
        // Preferir el nombre YA GUARDADO (de operaciones/conversaciones
        // anteriores, más confiable) sobre el nombre del perfil de WhatsApp
        // del mensaje actual -- nunca se inventa uno si ninguno es confiable.
        const nombre = primerNombreConfiable(cliente?.nombre) || primerNombreConfiable(pushName);
        // Si el cliente ya dijo "buenos días"/"boa noite"/etc., se le
        // corresponde con esa franja -- si el saludo es genérico ("hola"),
        // se usa la hora real de Brasil.
        const franja = franjaSaludoExplicita(txt) || franjaPorHora(horaSaoPaulo());

        const s = construirSaludo({ lang, esRegistrado, frecuente, nombre, franja });
        await guardarCliente({ phone, saludoEnviado: true });
        await enviarSeguro(phone, s);
        return s;
    }
    if (cliente?.estado === "cotizacion_realizada" && cliente?.ultimo_monto) {
        const m = pick(lang === "pt"
            ? [`Oi! Ainda quer fazer o envio de R$${cliente.ultimo_monto}? 💸`, `Olá! Continuamos com o envio de R$${cliente.ultimo_monto}? 😊`]
            : [`¡Hola! ¿Seguimos con el envío de R$${cliente.ultimo_monto}? 💸`, `¡Qué tal! ¿Continuamos con R$${cliente.ultimo_monto}? 😊`]);
        await enviarSeguro(phone, m); return m;
    }
    if (cliente?.estado === "aguardando_comprovante") {
        const m = pickL(ESPERA_COMPROBANTE_ES, ESPERA_COMPROBANTE_PT, lang);
        await enviarSeguro(phone, m); return "";
    }
    const m = lang === "pt"
        ? pick(["Quanto quer enviar? 😊", "O que precisa hoje? 😊"])
        : pick(["¿Cuánto quieres enviar? 😊", "¿En qué te ayudo? 😊"]);
    await enviarSeguro(phone, m); return m;
}

async function manejarImagen(phone, pushName, cliente, imageUrl, lang, esEs) {
    if (esPDF(imageUrl)) {
        if (cliente?.estado === "aguardando_comprovante") {
            const ref = cliente.fecha_pix || cliente.fecha_estado;
            if (ref && Date.now() - new Date(ref).getTime() > DOS_HORAS) {
                await limpiarSesion(phone);
                await enviarSeguro(phone, "La sesión expiró ⚠️\n\nTu comprobante será revisado manualmente.");
                return "";
            }
        }
        const datos = await detectarComprobantePDF(imageUrl);
        if (datos.valido || datos.tipo === "comprovante_pdf") await procesarComprobante(phone, pushName, cliente, datos, esEs);
        else {
            await enviarSeguro(phone, esEs
                ? "Recibido ✅\n\nTu comprobante será revisado manualmente en unos minutos."
                : "Recebido ✅\n\nSeu comprovante será revisado manualmente em alguns minutos.");
            const adminPhone = getAdminPhone();
            if (adminPhone) await enviarSeguro(adminPhone,
                `⚠️ *COMPROBANTE PDF NO LEGIBLE*\n\n👤 Cliente: ${pushName || cliente?.nombre || "-"}\n📱 Teléfono: ${phone}\n\nRevisar manualmente el PDF en el chat del cliente.`);
        }
        return "";
    }
    const det = await detectarImagenUnificada(imageUrl);
    if (det.tipo === "tarjeta") {
        const num = String(det.tarjeta || "").replace(/\D/g, "");
        if (det.banco?.toLowerCase().includes("bpa") && num.startsWith("1239")) { await enviarSeguro(phone, pick(TARJETA_ILEGIBLE)); return ""; }
        if (det.valida && /^\d{15,16}$/.test(num)) {
            await guardarTarjeta(phone, num, det.titular, det.banco, cliente);
            const cli2 = await obtenerCliente(phone);
            if (cli2.comprobante_pendiente) {
                // FIX LOOP: mismo caso que tarjeta por texto — no relanzar PIX.
                await intentarCompletarOperacion(phone, pushName, cli2, esEs);
                return "";
            }
            if (cli2.ultimo_monto && Number(cli2.ultimo_monto) > 0) {
                await guardarCliente({ phone, estado: "aguardando_comprovante", fechaEstado: new Date().toISOString(), fechaPix: new Date().toISOString() });
                // FIX: el cliente ya indicó la tarjeta en ESTE mensaje (foto) — no hay que
                // volver a preguntar cuál usar aunque tenga varias guardadas de antes.
                const montoPago = await montoPagoEnReales(cli2);
                const m = lang === "pt" ? `Cartão salvo! 💳\n\nVou te mandar o PIX para pagar R$${fmt(montoPago)} 👇` : `¡Tarjeta guardada! 💳\n\nTe envío el PIX para pagar R$${fmt(montoPago)} 👇`;
                await enviarSeguro(phone, m);
                return await _enviarPIXFinal(phone, cli2, esEs);
            }
            const m = pickL(CONFIRMA_TARJETA_SIN_MONTO, CONFIRMA_TARJETA_SIN_MONTO_PT, lang);
            await enviarSeguro(phone, m); return m;
        }
        await enviarSeguro(phone, pick(TARJETA_ILEGIBLE)); return "";
    }
    if (det.tipo === "comprovante_pix") {
        await crm.onComprobanteRecibido(phone, esEs ? "es" : "pt");
        await procesarComprobante(phone, pushName, cliente, det, esEs);
        return "";
    }
    return "";
}

async function preguntarCantidadUSD(phone, txt, lang, esEs) {
    const esClasica = /clasica|clásica|bpa|bandec/.test(txt);
    const esPrepago = /prepago|nauta|internacional/.test(txt);
    const esEfec    = /efectivo|cash/.test(txt);
    const tipo = esEfec ? "efectivo" : esClasica ? "clásica" : esPrepago ? "prepago" : null;
    const m = lang === "pt"
        ? `Certo${tipo ? ` (${tipo})` : ""} 💵\n\nQual o valor em USD que quer enviar?`
        : `Perfecto${tipo ? ` (${tipo})` : ""} 💵\n\n¿Cuánto USD quieres enviar?`;
    // Mismo mecanismo que tasaMLC() (ver cotizacion-flow.js) -- deja pendiente
    // el sub-tipo USD ya reconocido en ESTE mensaje (o "usd_clasica" por
    // defecto, mismo criterio que la línea de abajo en el bloque ── USD ──)
    // para que un monto suelto en el siguiente mensaje, sin repetir "usd",
    // se siga cotizando en USD.
    const tipoUsdInterno = esEfec ? "usd_efectivo" : esPrepago ? "usd_prepago" : "usd_clasica";
    await guardarCliente({ phone, ultimaPregunta: "moneda_pendiente", ultimasOpciones: [tipoUsdInterno] });
    await enviarSeguro(phone, m); return m;
}

module.exports = {
    detectarImagenUnificada, detectarComprobantePDF, procesarMensaje, logResultadoMensaje, extraerMonto, detectarTarjetaTexto,
    // exportada aparte para pruebas automáticas del formato de saludo sin
    // pasar por todo el router -- es pura, no manda WhatsApp ni toca la DB.
    construirSaludo
};
