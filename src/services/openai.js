"use strict";

require("dotenv").config();

const { guardarCliente, obtenerCliente }          = require("./customer-memory");
const { obtenerUltimaOperacion }                   = require("./operations");
const crm                                          = require("./crm");
const memoryMotor                                  = require("./memory-motor");

// Flows
const { detectarImagenUnificada, detectarComprobantePDF, llamarAsistente } = require("../flows/imagen-flow");
const { enviarPIX, _enviarPIXFinal, intentarCompletarOperacion, procesarComprobante, guardarTarjeta } = require("../flows/pix-flow");
const { cotizarBRL, cotizarUSD, preguntarTipoUSD, cotizarMLC, tasaMLC, detectarCUPInverso, cotizarCUPInverso, consultarTasas } = require("../flows/cotizacion-flow");
const { mostrarMenuRecargas, seleccionarRecarga, procesarNumeroRecarga } = require("../flows/recarga-flow");
const {
    enviarSeguro, limpiarSesion,
    norm, esPDF, pick, pickL,
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

async function procesarMensaje(phone, text, pushName = "", imageUrl = null) {
    try {
        if (!text || !phone) return "";

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
            }
            return "";
        }

        // FIX 3: Extraer monto ANTES de esCubaBrasil para que montoValido esté disponible
        const { valorFinal, valorMonetario, montoValido } = extraerMonto(txt, text);
        const soloNums = txt.replace(/\D/g, "");

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
        const esSaludo =
            // Saludo puro (con emojis, signos, nombre del bot al final)
            /^(hola|oi|bom dia|buenas|buenos dias|boa tarde|boa noite|buen dia|hey|hi|hello|e ai|eai|buenas tardes|buenas noches|good morning|ola|olá|eae|salve|boas|boa|que tal|como estas|como estás|tudo bem|tudo bom|bom dia yordanys|ola yordanys|hola yordanys|hola buen|hola buenas)[\s!?.🌙☀️🌤️]*$/i.test(txt) ||
            // Saludo seguido de nombre del bot
            /^(hola|oi|ola|olá|buenas|bom dia|boa tarde|boa noite)\s+(yordanys|yorda|bot)[\s!?.]*$/i.test(txt) ||
            // Solo emoji de saludo
            /^(👋|🙋|😊|🤝)$/.test(txt.trim());

        // Si el mensaje tiene saludo + pregunta juntos (buffer de varios mensajes)
        // ignorar el saludo y procesar solo la parte de negocio
        const lineas = text.split("\n").map(l => l.trim()).filter(Boolean);
        const primerLineaEsSaludo = lineas.length > 1 && esSaludo === false &&
            /^(hola|oi|bom dia|buenas|buenos|boa tarde|boa noite|hey|hi|hello|e ai|olá|ola)[\s!?.🌙☀️🌤️]*$/i.test(lineas[0]);

        if (primerLineaEsSaludo) {
            // Procesar solo las líneas de negocio, no el saludo
            const sinSaludo = lineas.slice(1).join(" ");
            if (sinSaludo) {
                return await procesarMensaje(phone, sinSaludo, pushName, imageUrl);
            }
        }
        if (esSaludo) return await manejarSaludo(phone, pushName, cliente, yaSaludado, lang, esEs);

        // ── Filtro de gatillo ──
        const esConfirma = confirmaOperacion.includes(txt.trim()) ||
            /\b(voy a|vou) (mandar|enviar|pagar|transferir)\b/.test(txt) ||
            /\b(te|le) (mando|envio|pago|transfiero)\b/.test(txt);
        const debeResponder = gatilhos.some(g => txt.includes(norm(g))) ||
            palabrasNegocio.some(p => txt.includes(p)) || !!cliente?.estado || !!imageUrl ||
            /^\d+([.,]\d{1,2})?$/.test(txt.trim()) || txt.replace(/\D/g,"").length === 16 || esConfirma;
        if (!debeResponder) return "";

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

        // ── GUARD: Cliente esperando comprobante → solo aceptar comprobante verbal o imagen ──
        // Cualquier otro texto en este estado se ignora o recibe recordatorio suave
        if (cliente?.estado === "aguardando_comprovante") {
            // Si es comprobante verbal → pedir foto
            if (/paguei|pague|comprovante|comprobante|feito|realizado|ya envie|ya mande|ya pague|hice el pago|fiz o pix|hice el pix/.test(txt)) {
                const m = esEs ? "¡Perfecto! Mándame el comprobante (foto o PDF) 📎" : "Ótimo! Me manda o comprovante (foto ou PDF) 📎";
                await enviarSeguro(phone, m); return m;
            }
            // Si es quierePagar → recordar que ya se envió el PIX
            if (/pix|llave|chave|clave/.test(txt)) {
                const m = esEs
                    ? pickL(ESPERA_COMPROBANTE_ES, ESPERA_COMPROBANTE_PT, lang)
                    : pickL(ESPERA_COMPROBANTE_ES, ESPERA_COMPROBANTE_PT, lang);
                await enviarSeguro(phone, m); return m;
            }
            // Cualquier otro texto → silencio (no interrumpir el flujo de pago)
            return "";
        }

        // FIX 2: Recarga sube antes de tarjetas — tiene su propio estado y no debe
        // pasar por checks de tarjeta/monto innecesariamente
        if (/recarga|recargar|recargas|recarga etecsa|recarga cuba|recargar telefono|recarga movil/.test(txt) &&
            cliente?.estado !== "aguardando_numero_recarga" && cliente?.estado !== "aguardando_comprovante")
            return await mostrarMenuRecargas(phone);

        if (cliente?.estado === "seleccionando_recarga" && /^[12]$/.test(txt.trim()))
            return await seleccionarRecarga(phone, txt.trim());

        if (cliente?.estado === "aguardando_numero_recarga" && /^5\d{7}$/.test(soloNums))
            return await procesarNumeroRecarga(phone, soloNums, esEs);

        // ── Selección de tarjeta ──
        if (cliente?.estado === "seleccionando_tarjeta") {
            const tarjetas = Array.isArray(cliente?.tarjetas) ? cliente.tarjetas.filter(t => /^\d{15,16}$/.test(t)) : [];

            // Respuesta a "¿usamos la guardada?" → sí/no
            const esSi =
                /^(si|sí|yes|sim|claro|ok|dale|esa|essa|la misma|la de siempre|usala|use essa|esa misma|esa que te envie|esa que te envié|a esa|usa esa|manda el pix|envia el pix|envía el pix|manda o pix|envia o pix|esa misma tarjeta|con esa|con esa misma)$/i.test(txt.trim()) ||
                // Frases más largas que contienen confirmación de tarjeta
                /a esa (que|tarjeta)|esa (que|tarjeta) (te |le )?(envie|envié|mande|mandé|pasé|pase)|usa(r)? (esa|la misma)|con (esa|la misma)|envia(me)? (el|o) pix|manda(me)? (el|o) pix/i.test(txt);
            const esNo = /^(no|nao|não|otra|outra|cambiar|mudar|nueva|nova|otra tarjeta|outra tarjeta)$/i.test(txt.trim());

            if (esSi && cliente?.tarjeta_frecuente && !tarjetas.length) {
                // Confirma usar la tarjeta frecuente
                await guardarCliente({ phone, tarjeta: cliente.tarjeta_frecuente, estado: "aguardando_comprovante", fechaEstado: new Date().toISOString(), fechaPix: new Date().toISOString() });
                return await _enviarPIXFinal(phone, await obtenerCliente(phone), esEs);
            }
            if (esNo && !tarjetas.length) {
                // Quiere usar otra tarjeta
                const msg = lang === "pt" ? "Tudo bem! Manda uma foto ou os 16 dígitos do novo cartão 💳" : "¡Sin problema! Mándame foto o los 16 dígitos de la nueva tarjeta 💳";
                await guardarCliente({ phone, estado: null });
                await enviarSeguro(phone, msg); return msg;
            }

            // Selección numérica (múltiples tarjetas)
            if (/^[1-9]$/.test(txt.trim()) && tarjetas.length) {
                const idx = parseInt(txt.trim()) - 1;
                if (idx >= 0 && idx < tarjetas.length) {
                    await guardarCliente({ phone, tarjeta: tarjetas[idx], tarjeta_frecuente: tarjetas[idx], estado: "aguardando_comprovante", fechaEstado: new Date().toISOString(), fechaPix: new Date().toISOString() });
                    return await _enviarPIXFinal(phone, await obtenerCliente(phone), esEs);
                }
            }
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

        // ── Estado aguardando monto USD — número siguiente es USD ──
        if (cliente?.estado === "aguardando_monto_usd" && montoValido) {
            const tipoUSD = cliente?.tipo_favorito || "usd_clasica";
            await guardarCliente({ phone, estado: null });
            return await cotizarUSD(phone, pushName, valorFinal, tipoUSD, lang, esEs) || "";
        }

        // ── Tarjeta por texto ──
        const esTarjeta = detectarTarjetaTexto(text);
        if (esTarjeta) {
            await guardarTarjeta(phone, esTarjeta, null, null, cliente);
            const cli2 = await obtenerCliente(phone);
            if (cli2.comprobante_pendiente && await intentarCompletarOperacion(phone, pushName, cli2, esEs)) return "";
            if (cli2.ultimo_monto && Number(cli2.ultimo_monto) > 0) {
                // Guardar estado Y recargar cliente ANTES de enviar PIX
                await guardarCliente({ phone, tarjeta: esTarjeta, estado: "aguardando_comprovante", fechaEstado: new Date().toISOString(), fechaPix: new Date().toISOString() });
                const cli3 = await obtenerCliente(phone);   // recargar con tarjeta + estado actualizados
                const m = lang === "pt" ? `Cartão salvo! 💳\n\nVou te mandar o PIX para pagar R$${cli3.ultimo_monto} 👇` : `¡Tarjeta guardada! 💳\n\nTe envío el PIX para pagar R$${cli3.ultimo_monto} 👇`;
                await enviarSeguro(phone, m);
                return await _enviarPIXFinal(phone, cli3, esEs);   // usar _enviarPIXFinal directamente, tarjeta ya guardada
            }
            const m = pickL(CONFIRMA_TARJETA_SIN_MONTO, CONFIRMA_TARJETA_SIN_MONTO_PT, lang);
            await enviarSeguro(phone, m); return m;
        }

        // ── QR ilegible ──
        if (/qr|codigo qr|no puedo escanear|no leo el qr|no consigo escanear/.test(txt)) {
            const key = getPIXKey();
            const m   = key ? `No hay problema 😊\n\nCopia la clave PIX:\n\n${key}` : "Pídele la clave directamente a Yordanys 😊";
            await enviarSeguro(phone, m); return m;
        }

        // FIX 4: Número solo con estado activo → cotizar en lugar de silencio
        // Si el cliente manda solo "200" y tiene estado activo, tratar como monto
        if (/^\d+$/.test(txt.trim()) && montoValido && cliente?.estado) {
            const estadoActual = cliente.estado;
            if (estadoActual === "cotizacion_realizada") {
                // Ya cotizó, este número puede ser confirmación de monto diferente
                return await cotizarBRL(phone, pushName, valorFinal, lang) || "";
            }
            if (!estadoActual || estadoActual === "nuevo_cliente") {
                return await cotizarBRL(phone, pushName, valorFinal, lang) || "";
            }
        }

        // FIX 5: Confirmación — verificar que NO hay monto nuevo en el mensaje
        // "quiero 200 reales" no debe confirmar, debe cotizar
        if (esConfirma && cliente?.estado === "cotizacion_realizada" && !montoValido) {
            if (!cliente.tarjeta && !cliente.tarjeta_frecuente) {
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
        const esMLC = txt.includes("mlc");

        // MLC: cliente paga reales y recibe MLC → cotizar directamente
        // "300 reales cuántos MLC" o "quiero enviar 300 en MLC" → cotizarMLC(300)
        if (esMLC && montoValido) return await cotizarMLC(phone, pushName, valorFinal, lang) || "";
        if (esMLC)                return await tasaMLC(phone, lang) || "";

        // ── CUP inverso ──
        const cupInv = detectarCUPInverso(txt);
        if (cupInv) { const r = await cotizarCUPInverso(phone, pushName, cupInv, lang); if (r) return r; }

        // ── Despedida ──
        const esDespedida =
            // Palabras exactas de despedida
            /^(gracias|ok gracias|hasta luego|chau|tchau|obrigado|obrigada|flw|valeu|até mais|adeus|hasta pronto|nos vemos|ciao|bye|byebye|hasta la proxima|até logo|até mais|muito obrigado|muito obrigada|muchas gracias|ok muchas gracias|gracias yordanys|obrigado yordanys)[\s!.😊👋]*$/i.test(txt.trim()) ||
            // Frases de cierre
            /^(ok (muchas )?gracias|(muchas )?gracias (yordanys|por todo|por tu ayuda)?|muito obrigad[ao]( yordanys)?|valeu (demais|muito)?|até (logo|mais|a próxima)|nos vemos pronto)[\s!.😊👋]*$/i.test(txt.trim());

        if (esDespedida) {
            const n = pushName ? `, ${pushName.split(" ")[0]}` : "";
            const m = lang === "pt"
                ? pick([
                    `Obrigada${n}! 😊 Foi um prazer. Aqui estaremos quando precisar. 👋`,
                    `Até logo${n}! 😊 Obrigada pela confiança. Qualquer coisa é só chamar. 👋`,
                    `Foi um prazer${n}! 😊 Quando precisar enviar para Cuba, estamos aqui. 👋`
                ])
                : pick([
                    `¡Fue un placer${n}! 😊 Gracias por la confianza. Aquí estaremos cuando nos necesites. 👋`,
                    `¡Hasta pronto${n}! 😊 Fue un gusto ayudarte. Cuando quieras, aquí estamos. 👋`,
                    `¡Gracias${n}! 😊 Aquí estaremos siempre que lo necesites. 👋`
                ]);
            await enviarSeguro(phone, m); return m;
        }

        // ── Consulta tasas ──
        if (/a cuanto|a como|tasa.*hoy|cambio.*hoy|hoy.*cambio|hoy.*tasa|cual es la tasa|como esta el cambio|como esta la tasa|cuanto vale|cuanto esta|precio.*hoy|hoy.*precio|tasa de hoy|cambio de hoy/.test(txt))
            return await consultarTasas(phone, lang) || "";

        // ── Estado de operación ──
        if (/estado|mi operacion|mi envio|cuando llega|cuando llego|cuanto falta|ya llego|esta listo/.test(txt)) {
            const ultima = await obtenerUltimaOperacion(phone);
            if (!ultima) { await enviarSeguro(phone, "No encuentro operaciones registradas 🤔\n\n¿Quieres hacer un envío?"); return ""; }
            await enviarSeguro(phone, `Tu última operación: R$${ultima.monto} — ${ultima.status === "confirmada" ? "✅ Confirmada" : "⏳ Pendiente"}`);
            return "";
        }

        // ── USD ──
        const esUSD = txt.includes("usd") || txt.includes("dolar") || txt.includes("dolares") || txt.includes("dólares");
        if (esUSD && !txt.includes("real") && !txt.includes("brl")) {
            if (!montoValido) return await preguntarCantidadUSD(phone, txt, lang, esEs) || "";
            const esEfectivo = /efectivo|cash|vender|cambiar|comprar/.test(txt);
            const esPrepago  = /prepago|nauta|internacional/.test(txt);
            const esClasica  = /clasica|clásica|classica|clássica|clasica|bpa|bandec|metropolitano/.test(txt);
            if (!esEfectivo && !esPrepago && !esClasica) return await preguntarTipoUSD(phone, pushName, valorFinal, lang, esEs) || "";
            return await cotizarUSD(phone, pushName, valorFinal, esEfectivo ? "usd_efectivo" : esPrepago ? "usd_prepago" : "usd_clasica", lang, esEs) || "";
        }

        // FIX 6: BRL→CUP — NO disparar si el cliente está esperando comprobante
        const esMonedaNacional = /moneda nacional|en cup\b|a cup\b|pesos cubanos|peso cubano/.test(txt);
        const estadoBloquea    = cliente?.estado === "aguardando_comprovante" ||
                                  cliente?.estado === "aguardando_numero_recarga";
        const hayContextoBRL   = valorMonetario !== null ||
            (!estadoBloquea && !!cliente?.estado) ||
            /enviar|mandar|envio|cotiz|transfer|pagar|monto|quant|cuant|quanto|quiero/.test(txt) ||
            esMonedaNacional;
        if (montoValido && hayContextoBRL && !esUSD && !esMLC && !estadoBloquea) {
            // MEJORA 2: beat de procesamiento antes de cotizar — sensación humana
            const montoAnteriorCot = Number(cliente?.ultimo_monto);
            const esMontoNuevo     = !montoAnteriorCot || Math.abs(montoAnteriorCot - valorFinal) > 1;
            const hayIntencion     = /enviar|mandar|cotiz|quiero|necesito|quero|preciso/.test(txt);
            if (esMontoNuevo && hayIntencion && valorFinal >= 50) {
                const beat = lang === "pt"
                    ? pick(["Entendido 👍 Deixa eu calcular o valor que vai chegar em Cuba...", "Certo 😊 Calculando agora..."])
                    : pick(["Entendido 👍 Déjame calcular cuánto llega a Cuba...", "Perfecto 😊 Calculando ahora..."]);
                await enviarSeguro(phone, beat, 600);
            }
            return await cotizarBRL(phone, pushName, valorFinal, lang) || "";
        }

        if (valorFinal && !montoValido) return "";

        // GRUPO A-1: Detectar urgencia
        // "es urgente / necesito hoy / ahora mismo / mi familia necesita"
        if (/urgent|ahora mismo|lo necesito hoy|necesito hoy|para hoy|lo antes posible|inmediatamente|rapido.*envio|envio.*rapido|minha familia precisa|urgente|preciso agora|agora mesmo/.test(txt) &&
            !imageUrl) {
            const m = lang === "pt"
                ? pick([
                    "Entendido, vamos agilizar 😊\n\nMe diz o valor e a gente resolve agora mesmo.",
                    "Sem problema, priorizamos sua operação 😊\n\nQual o valor que precisa enviar?",
                    "Vamos resolver isso agora 😊\n\nMe fala o valor."
                ])
                : pick([
                    "Entendido, vamos a agilizarlo 😊\n\nDime el monto y lo resolvemos ahora mismo.",
                    "Sin problema, priorizamos tu operación 😊\n\n¿Cuánto necesitas enviar?",
                    "Vamos a resolverlo ahora 😊\n\nDime el monto."
                ]);
            await enviarSeguro(phone, m); return m;
        }

        // GRUPO A-2: Detectar indecisión — darle espacio, no presionar
        if (/estoy pensando|no se si|no sé si|talvez|tal vez|quizas|quizás|vou pensar|to pensando|deixa eu ver|déjame pensar|no estoy seguro|nao sei/.test(txt)) {
            const m = lang === "pt"
                ? pick([
                    "Claro, sem pressa 😊 Estou aqui quando precisar.",
                    "Tudo bem, pode pensar 😊 Se tiver alguma dúvida me fala.",
                    "Sem problema 😊 Quando quiser, é só me chamar."
                ])
                : pick([
                    "No hay problema 😊 Tómate tu tiempo. Aquí estoy cuando lo necesites.",
                    "Claro, sin prisa 😊 Si tienes alguna duda me dices.",
                    "Perfecto 😊 Cuando quieras seguir, aquí estoy."
                ]);
            await enviarSeguro(phone, m); return m;
        }

        // GRUPO B-1: Detectar emociones
        const emocion = detectarEmocion(txt);
        if (emocion) {
            // Guardar última emoción en DB (async, no bloquear)
            guardarCliente({ phone, ultimaEmocion: emocion }).catch(() => {});
        }

        // Responder a emociones específicas que no son errores ni urgencia
        if (/preocupado|preocupada|nervioso|nerviosa|miedo|desconfio|preocupado|ansioso|ansied/.test(txt)) {
            const m = lang === "pt"
                ? "Entendo sua preocupação 😊 Trabalhamos todos os dias com famílias cubanas no Brasil. Estou aqui do seu lado durante todo o processo."
                : "Entiendo tu preocupación 😊 Trabajamos todos los días con familias cubanas en Brasil. Estoy aquí contigo durante todo el proceso.";
            await enviarSeguro(phone, m); return m;
        }
        if (/frustrad|molest|enojad|cansad|harto|chateado|irritad/.test(txt)) {
            const m = lang === "pt"
                ? pick(["Entendo 😊 Vamos resolver isso juntos.", "Desculpe o transtorno 😊 Me diz o que aconteceu e a gente resolve."])
                : pick(["Entiendo 😊 Vamos a resolverlo juntos.", "Disculpa las molestias 😊 Cuéntame qué pasó y lo solucionamos."]);
            await enviarSeguro(phone, m); return m;
        }

        // GRUPO B-2: Score de confianza — menos pasos para clientes de alto score
        const scoreCliente = Number(cliente?.score_confianza || 0);
        const esClienteVIP = scoreCliente >= 80 || !!cliente?.cliente_frecuente;

        // MEJORA 4: Empatía en errores — respuesta calmada y de acompañamiento
        if (/me equivoque|me equivoqué|error|equivocacion|me confundi|me confundí|hice mal|mande mal|envie mal|errei|me enganei/.test(txt)) {
            const m = lang === "pt"
                ? pick(["Não tem problema, vamos resolver juntos 😊 Me conta o que aconteceu.", "Tudo bem, sem estresse 😊 Me diz o que aconteceu e verificamos."])
                : pick(["No pasa nada, lo revisamos juntos 😊 Cuéntame qué pasó.", "Tranquilo, sin problema 😊 Dime qué ocurrió y lo solucionamos."]);
            await enviarSeguro(phone, m); return m;
        }
        if (/envie menos|envié menos|mande menos|pague menos|paguei menos|valor diferente|monto diferente/.test(txt)) {
            const m = lang === "pt"
                ? "Obrigada por avisar 😊 Vou verificar esse pagamento. Me manda o comprovante quando puder."
                : "Gracias por avisar 😊 Voy a revisar ese pago. Mándame el comprobante cuando puedas.";
            await enviarSeguro(phone, m); return m;
        }
        if (/es seguro|é seguro|confiable|confiavel|fraude|estafa|desconfio|desconfío/.test(txt)) {
            const m = lang === "pt"
                ? "Sim, é seguro 😊 Trabalhamos todos os dias com envios entre Brasil e Cuba. Se tiver qualquer dúvida durante o processo, estou aqui passo a passo."
                : "Sí, es seguro 😊 Trabajamos todos los días con envíos entre Brasil y Cuba. Si tienes cualquier duda durante el proceso, te acompaño paso a paso.";
            await enviarSeguro(phone, m); return m;
        }

        // ── Cuba sin monto ──
        if (txt.includes("cuba") && /dinero|enviar|mandar|pasar|plata|remesa/.test(txt)) {
            const n = pushName ? `, ${pushName.split(" ")[0]}` : "";
            await enviarSeguro(phone, `¡Hola${n}! 😊\n\n¿Cuánto quieres enviar a Cuba?`); return "";
        }

        // ── Intención sin monto ──
        if (/quiero enviar|necesito enviar|quiero mandar|quiero hacer (una )?(remesa|transferencia)|necesito (una )?(remesa|transferencia)/.test(txt)) {
            // Si ya tiene monto guardado → no preguntar de nuevo, avanzar al siguiente paso
            if (Number(cliente?.ultimo_monto) > 0) {
                if (!cliente?.tarjeta && !cliente?.tarjeta_frecuente) {
                    const m = lang === "pt"
                        ? `Só falta o cartão de destino 💳\n\nManda uma foto ou os 16 dígitos.`
                        : `Solo falta la tarjeta de destino 💳\n\nEnvíame foto o los 16 dígitos.`;
                    await enviarSeguro(phone, m); return m;
                }
                return await enviarPIX(phone, cliente, esEs);
            }
            await enviarSeguro(phone, lang === "pt" ? "Perfeito 😊\n\nQual o valor que quer enviar?" : "Perfecto 😊\n\n¿Cuánto deseas enviar?"); return "";
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
        if (palabras.length < 4 || /^\d+$/.test(txt.trim())) return "";
        try {
            const { texto, responseId } = await llamarAsistente(text, cliente?.last_response_id, {
                nombre:          cliente?.nombre,
                idioma:          lang,
                ultimo_monto:    cliente?.ultimo_monto,
                tipo_favorito:   cliente?.tipo_favorito,
                ops_completadas: cliente?.ops_completadas
            });
            const esIgnorar = /^ignorar[.!]?$/i.test(texto.trim()) || /silencio total/i.test(texto) || texto.trim() === "";
            if (texto && !esIgnorar) {
                await guardarCliente({ phone, lastResponseId: responseId });
                await enviarSeguro(phone, texto);
                return texto;
            }
        } catch (e) { console.error("❌ Asistente:", e.message); }

    } catch (e) { console.error("❌ procesarMensaje:", e.message); }
    return "";
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

function detectarEmocion(txt) {
    if (/preocupado|preocupada|nervioso|ansioso|miedo|desconfio/.test(txt)) return "preocupado";
    if (/frustrad|molest|enojad|cansad|harto|chateado/.test(txt)) return "frustrado";
    if (/gracias|obrigad|feliz|contento|alegre|genial|excelente/.test(txt)) return "agradecido";
    if (/urgente|rapido|ahora mismo|agora mesmo|preciso agora/.test(txt)) return "urgente";
    return null;
}

function extraerMonto(txt, text) {
    // Normalizar texto: "2.6000" → "2600", "400 000" → "400000", "2,600" → "2600"
    const textNorm = text
        .replace(/(\d)[\s.](?=\d{3}\b)/g, "$1")   // "400 000" → "400000", "2.600" → "2600"
        .replace(/(\d),(\d{3})\b/g, "$1$2");         // "2,600" → "2600"
    const txtNorm = textNorm.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    const MONTO_MONETARIO = /(?:r\$|reais|reales|real|brl|usd|d[oó]lar(?:es)?|cup|mlc|pesos?|plata|dinero)\s*(\d{2,6})|\b(\d{2,6})\s*(?:r\$|reais|reales|real|brl|usd|d[oó]lar(?:es)?|cup|mlc|pesos?)/i;
    const matchMonetario  = textNorm.match(MONTO_MONETARIO);
    const valorMonetario  = matchMonetario ? Number(matchMonetario[1] || matchMonetario[2]) : null;

    let valorContextual = null;
    if (!valorMonetario && /enviar|mandar|envio|cotiz|transfer|pagar|monto|quant|cuant|quanto|quiero/.test(txtNorm)) {
        const mc = /\b(\d{2,6})\b/g;
        let m;
        while ((m = mc.exec(txtNorm)) !== null) { const n = Number(m[1]); if (n >= 10 && n <= 99999) { valorContextual = n; break; } }
    }
    const valorFinal  = valorMonetario || valorContextual || null;
    const montoValido = !!(valorFinal && valorFinal >= 10 && valorFinal <= 99999);
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

async function manejarSaludo(phone, pushName, cliente, yaSaludado, lang, esEs) {
    const n    = pushName ? pushName.split(" ")[0] : null;
    const frec = !!cliente?.cliente_frecuente;
    const h    = new Date(Date.now() - 3 * 60 * 60 * 1000).getUTCHours();

    // Datos de memoria
    const tarjetaGuardada = cliente?.tarjeta_frecuente || cliente?.tarjeta;
    const montoAnterior   = Number(cliente?.ultimo_monto) > 0 ? cliente.ultimo_monto : null;
    const scoreCliente    = Number(cliente?.score_confianza || 0);
    const esVIP           = scoreCliente >= 80 || frec;
    const ultimaInteraccion = cliente?.ultima_interaccion;
    const diasInactivo = ultimaInteraccion
        ? Math.floor((Date.now() - new Date(ultimaInteraccion).getTime()) / (1000 * 60 * 60 * 24))
        : 0;

    // Cliente que ya fue saludado — retomar conversacion
    if (yaSaludado) {
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
        if (esVIP && diasInactivo >= 30) {
            const dias = diasInactivo >= 90
                ? (lang === "pt" ? "muito tempo" : "mucho tiempo")
                : (lang === "pt" ? "um tempo" : "un tiempo");
            const m = lang === "pt"
                ? `Que bom te ver de volta após ${dias} 😊 Já tenho seus dados. Como posso te ajudar hoje?`
                : `¡Qué bueno verte de nuevo después de ${dias}! 😊 Ya tengo tus datos. ¿Cómo puedo ayudarte hoy?`;
            await enviarSeguro(phone, m); return m;
        }
        // Fallback siempre presente para cliente que ya saludó
        const mf = lang === "pt"
            ? pick(["Olá de novo! 😊 Em que posso te ajudar?", "Oi! 😊 O que precisa hoje?"])
            : pick(["¡Hola de nuevo! 😊 ¿En qué te ayudo?", "¡Hola! 😊 ¿Qué necesitas hoy?"]);
        await enviarSeguro(phone, mf); return mf;
    }

    // Primer saludo — motor de memoria + anticipacion
    const anticipacion = await memoryMotor.generarAnticipacion(phone).catch(() => null);

    if (anticipacion?.sugerirRepetir && anticipacion?.sugerirMonto && tarjetaGuardada) {
        const ultimos = String(tarjetaGuardada).slice(-4);
        const monto   = anticipacion.sugerirMonto;
        const m = lang === "pt"
            ? `Que bom te ver 😊 Normalmente você envia R$${monto} para o cartão *••••${ultimos}*. Fazemos o mesmo hoje?`
            : `¡Qué bueno verte 😊 Normalmente envías R$${monto} a la tarjeta *••••${ultimos}*. ¿Lo repetimos hoy?`;
        await guardarCliente({ phone, saludoEnviado: true });
        await enviarSeguro(phone, m); return m;
    }
    if (frec && tarjetaGuardada && montoAnterior) {
        const ultimos = String(tarjetaGuardada).slice(-4);
        const m = lang === "pt"
            ? `Que bom te ver de novo 😊\n\nDa última vez enviaste R$${montoAnterior} para o cartão *••••${ultimos}*. Vamos fazer o mesmo hoje?`
            : `¡Qué bueno verte de nuevo 😊\n\nLa última vez enviaste R$${montoAnterior} a la tarjeta *••••${ultimos}*. ¿Hacemos lo mismo hoy?`;
        await guardarCliente({ phone, saludoEnviado: true });
        await enviarSeguro(phone, m); return m;
    }
    if (frec && tarjetaGuardada) {
        const ultimos = String(tarjetaGuardada).slice(-4);
        const m = lang === "pt"
            ? `Olá de novo 😊 Já tenho seu cartão *••••${ultimos}* guardado. Quanto vai enviar hoje?`
            : `¡Hola de nuevo 😊 Ya tengo tu tarjeta *••••${ultimos}* guardada. ¿Cuánto vas a enviar hoy?`;
        await guardarCliente({ phone, saludoEnviado: true });
        await enviarSeguro(phone, m); return m;
    }
    if (montoAnterior && !frec) {
        const m = lang === "pt"
            ? pick([`Da última vez enviaste R$${montoAnterior}. Vai ser o mesmo valor hoje? 😊`, `Quanto quer enviar hoje? 😊`])
            : pick([`La última vez enviaste R$${montoAnterior}. ¿El mismo monto hoy? 😊`, `¿Cuánto quieres enviar? 😊`]);
        await guardarCliente({ phone, saludoEnviado: true });
        await enviarSeguro(phone, m); return m;
    }

    // Saludo nuevo por hora e idioma
    let s;
    if (lang === "pt") {
        const pn = n ? ` ${n}` : "";
        if (frec)        s = pick([`Oi${pn}! Que bom te ver de novo 😊 Em que posso te ajudar hoje?`, `Olá${pn}! Sempre bom contar com você 😊 O que precisa hoje?`]);
        else if (h < 12) s = pick([`Bom dia${pn}! ☀️ Como posso te ajudar?`, `Olá${pn}, bom dia! ☀️ Em que posso ajudar?`]);
        else if (h < 18) s = pick([`Boa tarde${pn}! 🌤️ Como posso te ajudar?`, `Oi${pn}! Boa tarde ☀️ Em que posso ajudar hoje?`]);
        else             s = pick([`Boa noite${pn}! 🌙 Como posso te ajudar?`, `Oi${pn}! Boa noite 🌙 Estou aqui para o que precisar.`]);
    } else {
        const pn = n ? `, ${n}` : "";
        if (frec)        s = pick([`¡Hola${pn}! Qué bueno verte de nuevo 😊 ¿En qué te ayudo hoy?`, `¡Hola${pn}! Siempre un placer 😊 ¿Qué necesitas?`]);
        else if (h < 12) s = pick([`¡Buenos días${pn}! ☀️ ¿En qué te puedo ayudar?`, `¡Hola${pn}, buenos días! ☀️ ¿Qué necesitas?`]);
        else if (h < 18) s = pick([`¡Buenas tardes${pn}! 🌤️ ¿En qué te ayudo?`, `¡Hola${pn}! Buenas tardes 😊 ¿Qué necesitas?`]);
        else             s = pick([`¡Buenas noches${pn}! 🌙 ¿En qué te ayudo?`, `¡Hola${pn}! Buenas noches 😊 ¿Qué necesitas?`]);
    }
    await guardarCliente({ phone, saludoEnviado: true });
    await enviarSeguro(phone, s);
    return s;
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
        else await enviarSeguro(phone, esEs ? "No pude leer el PDF 📄\n\nAsegúrate de que sea un comprobante válido." : "Não consegui ler o PDF 📄\n\nVerifique se é um comprovante válido.");
        return "";
    }
    const det = await detectarImagenUnificada(imageUrl);
    if (det.tipo === "tarjeta") {
        const num = String(det.tarjeta || "").replace(/\D/g, "");
        if (det.banco?.toLowerCase().includes("bpa") && num.startsWith("1239")) { await enviarSeguro(phone, pick(TARJETA_ILEGIBLE)); return ""; }
        if (det.valida && /^\d{15,16}$/.test(num)) {
            const estabaSeleccionando = cliente?.estado === "seleccionando_tarjeta";
            await guardarTarjeta(phone, num, det.titular, det.banco, cliente);
            const cli2 = await obtenerCliente(phone);

            // Si hay comprobante pendiente → intentar completar operación directamente
            if (cli2.comprobante_pendiente) {
                const completado = await intentarCompletarOperacion(phone, pushName, cli2, esEs);
                if (completado) return "";
            }

            if (cli2.ultimo_monto && Number(cli2.ultimo_monto) > 0) {
                await guardarCliente({ phone, tarjeta: num, estado: "aguardando_comprovante", fechaEstado: new Date().toISOString(), fechaPix: new Date().toISOString() });
                const m = lang === "pt" ? `Cartão salvo! 💳\n\nVou te mandar o PIX para pagar R$${cli2.ultimo_monto} 👇` : `¡Tarjeta guardada! 💳\n\nTe envío el PIX para pagar R$${cli2.ultimo_monto} 👇`;
                await enviarSeguro(phone, m);
                const cli3 = await obtenerCliente(phone);
                return await _enviarPIXFinal(phone, cli3, esEs);
            }
            // Sin monto ni comprobante → confirmar tarjeta y pedir monto
            if (estabaSeleccionando) {
                const m = lang === "pt" ? `Cartão salvo! 💳 Quanto vai enviar?` : `¡Tarjeta guardada! 💳 ¿Cuánto vas a enviar?`;
                await enviarSeguro(phone, m); return m;
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
    const esClasica = /clasica|clásica|classica|clássica|clasica|bpa|bandec/.test(txt);
    const esPrepago = /prepago|nauta|internacional/.test(txt);
    const esEfec    = /efectivo|cash/.test(txt);
    const tipo      = esEfec ? "efectivo" : esClasica ? "clásica" : esPrepago ? "prepago" : null;
    const tipoDb    = esEfec ? "usd_efectivo" : esClasica ? "usd_clasica" : esPrepago ? "usd_prepago" : "usd_pendiente_tipo";

    // Guardar tipo USD para que el próximo número sea procesado como USD
    await guardarCliente({ phone, tipo: tipoDb, estado: "aguardando_monto_usd", fechaEstado: new Date().toISOString() });

    const m = lang === "pt"
        ? `Certo${tipo ? ` (${tipo})` : ""} 💵\n\nQual o valor em USD que quer enviar?`
        : `Perfecto${tipo ? ` (${tipo})` : ""} 💵\n\n¿Cuánto USD quieres enviar?`;
    await enviarSeguro(phone, m); return m;
}

module.exports = { detectarImagenUnificada, detectarComprobantePDF, procesarMensaje };
