require("dotenv").config();

const OpenAI   = require("openai");
const pdfParse = require("pdf-parse");

const { enviarMensaje, enviarImagen }                     = require("./zapi");
const { calcularOperacion }                               = require("./calculator");
const { guardarCliente, obtenerCliente, limpiarSesionDB } = require("./customer-memory");
const { agregarOperacion, obtenerTodas, obtenerUltimaOperacion, obtenerPendienteCliente, existeOperacionPendiente } = require("./operations");
const env = require("../config/env");
const crm = require("./crm");

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const pool  = require("../../db");

async function leerRecargas() {
    try {
        const r = await pool.query("SELECT * FROM recargas WHERE activa = true ORDER BY tipo");
        return r.rows;
    } catch { return []; }
}

async function leerOferta() {
    try {
        const r = await pool.query("SELECT * FROM ofertas WHERE activa = true AND (vence_at IS NULL OR vence_at > NOW()) LIMIT 1");
        return r.rows[0]?.texto || null;
    } catch { return null; }
}

// ─────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────

const DOS_HORAS = 2 * 60 * 60 * 1000;

function getPIXKey()     { return env.PIX_KEY         || ""; }
function getPIXHolder()  { return env.PIX_HOLDER_NAME || ""; }
function getPIXBank()    { return env.PIX_BANK        || ""; }
function getPIXImage()   { return env.PIX_IMAGE_URL   || ""; }
function getAdminPhone() { return env.ADMIN_PHONE     || ""; }
function getPIXAliases() {
    return (env.PIX_HOLDER_ALIASES || "").split("|").map(s => s.trim()).filter(Boolean);
}

// ─────────────────────────────────────────
// GATILLOS — solo activan el bot si aparecen
// ─────────────────────────────────────────

const gatilhos = [
    "remesa","transferencia","transferir","enviar dinero","mandar dinero",
    "quiero enviar","necesito enviar","quiero mandar","enviar a cuba","mandar a cuba",
    "dinero para cuba","tasa","cotizacion","cotizar","a como esta","a cuanto esta",
    "cuanto recibe","cuanto llega","cuanto pagan","cuanto da","el cambio","cambio de hoy",
    "cup","peso cubano","pesos cubanos","usd","dolar","dolares",
    "recarga","saldo","pix","clave pix","qr pix","tarjeta","bpa","bandec","metropolitano",
    "como envio","como mando","quiero cotizar","pasame el pix","mandame el pix",
    "me interesa","quiero pagar","voy a pagar","pasar dinero","mandar plata","enviar plata",
    "mi familia en cuba","ayuda a mi familia","enviar para cuba","mandar para cuba",
    "hacer una remesa","necesito una remesa","quiero hacer un envio","quiero mandar dinero",
    "recarga","recargar","recarga etecsa","recarga cuba","quiero recargar","necesito recargar",
    "recarga para cuba","recarga de telefono","recargar telefono","recarga movil"
];

const palabrasNegocio = [
    "cuba","cup","usd","mlc","transferencia","remesa","pix","recarga","etecsa","tarjeta"
];

// Cuba→Brasil — parada total, derivar a humano
const triggersCubaBrasil = [
    "tengo cup","vender cup","cup por reales","dinero en cuba","traer para brasil",
    "traer dinero","enviar desde cuba","pesos cubanos","cambiar cup","cambio de cup",
    "cup a reales","cup a brl","tengo pesos cubanos","vendo cup","vendo pesos"
];

const confirmaOperacion = [
    "si","sí","ok","dale","vamos","quiero hacerlo","continuar","deseo continuar",
    "de acuerdo","hagamoslo","hagámoslo","continuemos","perfecto","listo","va",
    "claro","seguro","exacto","adelante","procede","procedemos","quiero","acepto"
];

const CIERRES_COT = [
    "¿Hacemos la operación ahora? 💸",
    "¿Quieres que te envíe el PIX para pagar?",
    "¿Continuamos? 👌",
    "¿Procedemos? Si tienes la tarjeta ya podemos cerrar.",
    "¿Lo hacemos ahora? Es rápido 🚀"
];

const CONFIRMA_TARJETA_SIN_MONTO = [
    "¡Listo! 💳 ¿Cuánto vas a enviar?",
    "¡Perfecto, tarjeta guardada! 💳 ¿Qué monto quieres enviar?",
    "¡Anotado! 💳 ¿Cuánto vas a mandar hoy?"
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ─────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────

function norm(t) {
    return String(t || "").toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function fmt(n) { return Number(n).toLocaleString("es-ES"); }

function parseGPT(t) {
    try {
        return JSON.parse(
            String(t || "").replace(/```json/gi,"").replace(/```/g,"").trim()
        );
    } catch { return {}; }
}

function esPDF(url) {
    if (!url) return false;
    const u = url.toLowerCase();
    return u.includes(".pdf") || u.includes("mimetype=pdf") || u.includes("type=pdf");
}

async function enviarSeguro(phone, msg) {
    if (!msg || !phone) return;
    await enviarMensaje(phone, msg);
}

async function limpiarSesion(phone) { await limpiarSesionDB(phone); }

// ─────────────────────────────────────────
// PROMPTS OCR
// ─────────────────────────────────────────

function promptImagen() {
    const aliases = getPIXAliases().join(", ");
    const key     = getPIXKey();
    return `Analiza la imagen. ¿Es tarjeta bancaria, comprobante PIX u otra cosa? Responde SOLO en JSON.

TARJETA: {"tipo":"tarjeta","tarjeta":"SOLO_DIGITOS","titular":"NOMBRE","banco":"banco","valida":true}
COMPROBANTE: {"tipo":"comprovante_pix","valor":200,"fecha":"DD/MM/AAAA","hora":"HH:MM","banco":"banco origen","destinatario":"nombre","destino_correcto":true,"valido":true}
OTRO: {"tipo":"otro"}

- tarjeta: solo dígitos, 15 o 16 caracteres.
- valor: número puro (200, no "R$200,00").
- destino_correcto=true si destinatario coincide con: ${aliases}.
${key ? `- destino_correcto=true si aparece la clave: ${key}` : ""}
- datos faltantes → null. Sin texto extra.`;
}

function promptPDF() {
    const aliases = getPIXAliases().join(", ");
    const key     = getPIXKey();
    return `Analiza el texto del comprobante. Responde SOLO en JSON.
{"tipo":"comprovante_pdf","valor":200,"fecha":"DD/MM/AAAA","hora":"HH:MM","banco":"banco origen","destinatario":"nombre","destino_correcto":true,"valido":true}
- valor: número puro. datos faltantes → null. Sin texto extra.
- destino_correcto=true si destinatario coincide con: ${aliases}.
${key ? `- destino_correcto=true si el texto contiene: ${key}` : ""}`;
}

// ─────────────────────────────────────────
// RESPONSES API — Asistente OpenAI
// Solo para mensajes conversacionales
// que no encajaron en ningún flujo
// ─────────────────────────────────────────

async function llamarAsistente(mensajeUsuario, lastResponseId = null) {
    const response = await openai.responses.create({
        model: "gpt-4o-mini",
        input: mensajeUsuario,
        instructions: `Eres Yorda, asistente de remesas Brasil→Cuba. Cálida, cercana y directa. Sin formalismos.

REGLA PRINCIPAL: Si el mensaje no tiene relación con envíos, remesas, tasas, PIX, tarjetas, Cuba, dinero → no respondas nada. Silencio total.

CÓMO RESPONDES:
- Máximo 2 líneas. Sin parrafadas.
- Siempre termina con una pregunta o acción concreta.
- Si preguntan si es seguro: "Llevamos tiempo ayudando a familias cubanas en Brasil, sin problemas 😊 ¿Cuánto quieres enviar?"
- Si preguntan cómo funciona: "Tú pagas por PIX y nosotros transferimos a la tarjeta en Cuba. Rápido y seguro 💪 ¿Cuánto quieres mandar?"
- Si preguntan cuánto tarda: "Normalmente entre 1 y 24h según la conectividad en Cuba 😊"
- Recargas ETECSA: "Eso lo maneja Yordanys directamente 😊 Aguarda un momento. 👌"

NUNCA: Inventes tasas ni montos. Prometas horarios exactos. Saludes. Respondas sobre política, salud o noticias.`,
        ...(lastResponseId && { previous_response_id: lastResponseId })
    });

    const texto = response.output
        ?.filter(b => b.type === "message")
        ?.flatMap(b => b.content)
        ?.filter(c => c.type === "output_text")
        ?.map(c => c.text)
        ?.join("") || "";

    return { texto: texto.trim(), responseId: response.id };
}

// ─────────────────────────────────────────
// OCR
// ─────────────────────────────────────────

async function detectarImagenUnificada(imageUrl) {
    try {
        const r = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: [
                { type: "text",      text: promptImagen() },
                { type: "image_url", image_url: { url: imageUrl } }
            ]}],
            max_tokens: 220
        });
        return parseGPT(r.choices?.[0]?.message?.content);
    } catch (e) {
        console.error("❌ OCR:", e.message);
        return { tipo: "otro" };
    }
}

async function detectarComprobantePDF(pdfUrl) {
    try {
        const resp     = await fetch(pdfUrl);
        const buf      = Buffer.from(await resp.arrayBuffer());
        const { text } = await pdfParse(buf);
        const r = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: promptPDF() + `\n\nTexto:\n${text}` }],
            max_tokens: 200
        });
        return parseGPT(r.choices?.[0]?.message?.content);
    } catch (e) {
        console.error("❌ PDF:", e.message);
        return {};
    }
}

// ─────────────────────────────────────────
// ENVIAR PIX — con validación completa
// ─────────────────────────────────────────

async function enviarPIX(phone, cliente, esEs) {
    if (!cliente?.ultimo_monto || Number(cliente.ultimo_monto) <= 0) {
        const msg = esEs ? "Primero dime cuánto vas a enviar 😊" : "Primeiro me diz quanto vai enviar 😊";
        await enviarSeguro(phone, msg);
        return msg;
    }
    const esRecarga = cliente?.tipo_favorito === "recarga_etecsa";
    if (!esRecarga && !cliente?.tarjeta && !cliente?.tarjeta_frecuente) {
        const msg = esEs
            ? "Solo me falta la tarjeta de destino 💳\n\nEnvíame una foto o los 16 dígitos."
            : "Só falta o cartão de destino 💳\n\nEnvie uma foto ou os 16 dígitos.";
        await enviarSeguro(phone, msg);
        return msg;
    }

    // Si tiene múltiples tarjetas, preguntar cuál usar
    const tarjetas = Array.isArray(cliente?.tarjetas) ? cliente.tarjetas.filter(t => /^\d{15,16}$/.test(t)) : [];
    if (!esRecarga && tarjetas.length > 1) {
        const opciones = tarjetas.map((t, i) => {
            const ultimos = t.slice(-4);
            const titular = cliente.titular_frecuente || "";
            return `${i + 1}️⃣ •••• ${ultimos}${titular ? " — " + titular.split(" ")[0] : ""}`;
        }).join("\n");
        const msg = `¿A cuál tarjeta envío hoy? 💳\n\n${opciones}`;
        await guardarCliente({ phone, estado: "seleccionando_tarjeta", fechaEstado: new Date().toISOString() });
        await enviarSeguro(phone, msg);
        return msg;
    }

    return await _enviarPIXFinal(phone, cliente, esEs);
}

// Envía el PIX con la tarjeta ya definida
async function _enviarPIXFinal(phone, cliente, esEs) {
    const key = getPIXKey(); const holder = getPIXHolder();
    const bank = getPIXBank(); const img = getPIXImage();

    if (img)    await enviarImagen(phone, img, "📲 Escanea el QR para pagar.");
    if (key)    await enviarSeguro(phone, key);
    if (holder) await enviarSeguro(phone, `Titular: ${holder}${bank ? `\n🏦 ${bank}` : ""}`);
    await enviarSeguro(phone, esEs
        ? "Después del pago envíame el comprobante 📎 y proceso tu envío enseguida 🚀"
        : "Após o pagamento envie o comprovante 📎 e processo imediatamente 🚀"
    );
    await crm.onPIXEnviado(phone, esEs ? "es" : "pt");
    return key;
}

// ─────────────────────────────────────────
// NOTIFICACIÓN AL ADMIN
// Se envía al ADMIN_PHONE, nunca al cliente
// ─────────────────────────────────────────

async function notificarAdmin(pushName, phone, monto, cup, banco, tarjeta, titular) {
    const adminPhone = getAdminPhone();
    if (!adminPhone) {
        console.warn("⚠️ ADMIN_PHONE no configurado — notificación no enviada");
        return;
    }
    await enviarSeguro(adminPhone,
        `📥 *NUEVA OPERACIÓN*\n👤 ${pushName}\n📱 ${phone}\n💵 R$${monto} → ${fmt(cup)} CUP\n🏦 ${banco || "-"}\n💳 ${tarjeta || "-"}\n👤 ${titular || "-"}\n⏳ Pendiente`
    );
}

// ─────────────────────────────────────────
// ETIQUETAR EN WASCRIPT CRM
// ─────────────────────────────────────────

async function etiquetarNuevoPedido(phone) {
    const token = process.env.WASCRIPT_TOKEN;
    if (!token) {
        console.warn("⚠️ WASCRIPT_TOKEN no configurado");
        return;
    }
    try {
        await fetch(`https://api-whatsapp.wascript.com.br/api/modificar-etiquetas/${token}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                phone: [phone],
                actions: [{ labelId: "2", type: "add" }]
            })
        });
        console.log(`🏷️ Etiqueta "Nuevo pedido" agregada: ${phone}`);
    } catch (e) {
        console.error("❌ Error etiquetando en Wascript:", e.message);
    }
}

// ─────────────────────────────────────────
// INTENTAR COMPLETAR OPERACIÓN
// Flujo flexible: verifica si ya tenemos
// todos los datos para crear la operación,
// sin importar el orden en que llegaron.
// ─────────────────────────────────────────

async function intentarCompletarOperacion(phone, pushName, cliente, esEs) {
    if (!cliente) return false;
    const esRecarga      = cliente.tipo_favorito === "recarga_etecsa";
    const tieneTarjeta   = !!(cliente.tarjeta || cliente.tarjeta_frecuente);
    const tieneComprobante = !!cliente.comprobante_pendiente;

    // Si tiene tarjeta + comprobante → el monto viene del comprobante,
    // el tipo por defecto es brl_cup. Cerrar sin pedir nada más.
    if (tieneTarjeta && tieneComprobante && !cliente.ultimo_monto) {
        const montoComp = Number(cliente.valor_comprobante);
        if (montoComp > 0) {
            await guardarCliente({ phone, monto: montoComp, tipo: cliente.tipo_favorito || "brl_cup" });
            // Recargar con los datos actualizados
            const cli2 = await obtenerCliente(phone);
            return await intentarCompletarOperacion(phone, pushName, cli2, esEs);
        }
    }

    const tieneMonto = Number(cliente.ultimo_monto) > 0;

    // Si tiene tarjeta + comprobante pero no tiene tipo → asumir brl_cup y cerrar
    if (tieneTarjeta && tieneComprobante && !cliente.tipo_favorito) {
        await guardarCliente({ phone, tipo: "brl_cup" });
        const cli2 = await obtenerCliente(phone);
        return await intentarCompletarOperacion(phone, pushName, cli2, esEs);
    }

    const tieneTipo = !!cliente.tipo_favorito;

    if (!tieneMonto || !tieneComprobante || (!tieneTarjeta && !esRecarga)) {
        if (!tieneMonto) {
            const msg = esEs ? "¿Cuánto vas a enviar? 😊" : "Quanto vai enviar? 😊";
            await enviarSeguro(phone, msg);
            return false;
        }
        if (!tieneTarjeta && !esRecarga) {
            const msg = esEs
                ? "Solo me falta la tarjeta de destino 💳\n\nEnvíame foto o los 16 dígitos."
                : "Só falta o cartão 💳\n\nFoto ou 16 dígitos.";
            await enviarSeguro(phone, msg);
            return false;
        }
        return false;
    }

    // ¡Tenemos todo! Verificar que no exista ya
    const yaExiste = await existeOperacionPendiente(phone, cliente.ultimo_monto);
    if (yaExiste) return true;

    const resultado = await calcularOperacion({ tipo: cliente.tipo_favorito, valor: cliente.ultimo_monto });

    await guardarCliente({ phone, comprobantePendiente: false });
    const operacion = await agregarOperacion({
        phone,
        nombre:  pushName || cliente.nombre || "Cliente",
        monto:   cliente.ultimo_monto,
        cup:     resultado?.cup || 0,
        tarjeta: cliente.tarjeta || cliente.tarjeta_frecuente || "",
        titular: cliente.titular || cliente.titular_frecuente || "",
        banco:   cliente.banco_detectado || "",
        tipo:    cliente.tipo_favorito
    });

    const opId = operacion?.id ? `#${operacion.id} ` : "";

    // Tarjeta en grupos de 4 — copiable en WhatsApp
    const tarjetaRaw = cliente.tarjeta || cliente.tarjeta_frecuente || "-";
    const tarjetaFmt = tarjetaRaw !== "-"
        ? tarjetaRaw.replace(/(.{4})/g, "$1 ").trim()
        : "-";

    // Mensaje de operación — igual para admin y cliente
    const msgOperacion = `📥 *OPERACIÓN ${opId}PENDIENTE*

👤 Cliente: ${pushName || cliente.nombre}

📱 Teléfono: ${phone}

💵 Enviado: R$${cliente.ultimo_monto}

🇨🇺 Recibe: ${fmt(resultado?.cup || 0)} CUP

🏦 Banco: ${cliente.banco_detectado || "-"}

💳 Tarjeta:
${tarjetaFmt}

👤 Titular:
${cliente.titular || cliente.titular_frecuente || "-"}

⏳ Estado:
Pendiente de validación`;

    // Enviar al cliente
    await enviarSeguro(phone, msgOperacion);

    // Enviar al admin
    const adminPhone = getAdminPhone();
    if (adminPhone) {
        await enviarSeguro(adminPhone, msgOperacion);
    } else {
        console.warn("⚠️ ADMIN_PHONE no configurado");
    }

    // Etiquetar en Wascript CRM
    await etiquetarNuevoPedido(phone);

    await limpiarSesion(phone);
    return true;
}

// ─────────────────────────────────────────
// PROCESAR COMPROBANTE
// ─────────────────────────────────────────

async function procesarComprobante(phone, pushName, cliente, datos, esEs) {
    if (datos.destino_correcto === false) {
        await enviarSeguro(phone, "⚠️ El comprobante no es para nuestra cuenta.\n\nVerifica el destinatario y reenvíalo.");
        return "";
    }

    // Validar comprobante duplicado — mismo valor + misma fecha/hora
    if (datos.valor && datos.fecha && datos.hora) {
        try {
            const dupCheck = await pool.query(`
                SELECT id FROM operations
                WHERE monto = $1
                AND created_at > NOW() - INTERVAL '24 hours'
                AND status != 'rechazada'
                LIMIT 1
            `, [Number(datos.valor)]);

            if (dupCheck.rows.length > 0) {
                // Verificar si el cliente actual ya tiene una operación con ese monto
                const dupCliente = await pool.query(`
                    SELECT id FROM operations
                    WHERE phone = $1 AND monto = $2
                    AND created_at > NOW() - INTERVAL '2 hours'
                    LIMIT 1
                `, [phone, Number(datos.valor)]);

                if (dupCliente.rows.length > 0) {
                    await enviarSeguro(phone, "⚠️ Este comprobante ya fue procesado anteriormente.\n\nSi tienes alguna duda contacta a Yordanys. 😊");
                    return "";
                }
            }
        } catch (e) {
            console.error("❌ Error validando duplicado:", e.message);
        }
    }

    // Guardar que llegó el comprobante.
    // Si el cliente no tenía monto, tomarlo del comprobante.
    // NO asumir tipo — se pedirá al cliente si no hay cotización previa.
    await guardarCliente({
        phone,
        comprobantePendiente: true,
        valorComprobante: datos.valor ?? null,
        ...(datos.valor && !cliente.ultimo_monto && {
            monto: datos.valor
            // tipo intencionalmente omitido — se confirma con el cliente
        })
    });

    // Verificar monto contra operación pendiente existente
    const opPend = await obtenerPendienteCliente(phone);

    if (opPend && datos.valor &&
        Math.round(Number(datos.valor)) !== Math.round(Number(opPend.monto))
    ) {
        await enviarSeguro(phone,
            `⚠️ El comprobante es R$${datos.valor} pero la operación es R$${opPend.monto}.\n\nVerifica y reenvíalo.`
        );
        return "";
    }

    // Recargar cliente con los datos recién guardados
    const clienteActualizado = await obtenerCliente(phone);

    // Intentar completar con lo que tenemos
    const completado = await intentarCompletarOperacion(phone, pushName, clienteActualizado, esEs);

    if (!completado) {
        // Solo confirmar recepción si no se completó aún
        await enviarSeguro(phone, esEs
            ? "¡Comprobante recibido! ✅"
            : "Comprovante recebido! ✅"
        );
    }

    return "";
}

// ─────────────────────────────────────────
// GUARDAR TARJETA — helper reutilizable
// ─────────────────────────────────────────

async function guardarTarjeta(phone, num, titular, banco, cliente) {
    const arr = Array.isArray(cliente?.tarjetas) ? [...cliente.tarjetas] : [];
    if (!arr.includes(num)) arr.push(num);
    await guardarCliente({
        phone, tarjeta: num, titular: titular || "",
        bancoDetectado: banco || "", tarjeta_frecuente: num,
        titular_frecuente: titular || "", banco_detectado: banco || "",
        tarjetas: arr
    });
}

// ─────────────────────────────────────────
// PROCESAR MENSAJE
// ─────────────────────────────────────────

async function procesarMensaje(phone, text, pushName = "", imageUrl = null) {
    try {
        if (!text || !phone) return "";

        const txt  = norm(text);
        const esEs = /hola|buenas|buenos|quiero|cuanto|enviar|mandar|giro|transferencia|dinero|cuba|pesos|cup|reales|usd|dolares|dolar|tasa|cambio/.test(txt);

        const cliente    = await obtenerCliente(phone);
        const yaSaludado = !!cliente?.saludo_enviado;

        // ── Idioma y primer contacto CRM ──
        const lang = crm.detectarIdioma(text);
        crm.registrarPrimerContacto(phone, pushName, lang).catch(() => {});

        await guardarCliente({ phone, ultimaInteraccion: new Date().toISOString() });

        // ══════════════════════════════════════
        // HORARIO DE ATENCIÓN (8am - 11pm hora Brasil UTC-3)
        // ══════════════════════════════════════

        const horaBrasil = new Date(Date.now() - 3 * 60 * 60 * 1000).getUTCHours();
        const fueraDeHorario = horaBrasil < 8 || horaBrasil >= 23;

        if (fueraDeHorario && !imageUrl) {
            // Solo avisar una vez por sesión nocturna
            const ultimaInteraccion = cliente?.ultima_interaccion;
            const yaAvisado = ultimaInteraccion &&
                (Date.now() - new Date(ultimaInteraccion).getTime()) < 60 * 60 * 1000;
            if (!yaAvisado) {
                const msg = esEs
                    ? "Estamos fuera de horario 😊\n\nNuestro horario de atención es de 8am a 11pm (hora de Brasil).\n\nTe responderemos en cuanto estemos disponibles. 👌"
                    : "Estamos fora do horário 😊\n\nNosso horário de atendimento é das 8h às 23h (horário de Brasília).\n\nResponderemos assim que estivermos disponíveis. 👌";
                await enviarSeguro(phone, msg);
            }
            return "";
        }

        // ══════════════════════════════════════
        // GATILLO NEGATIVO: Cuba→Brasil
        // Para total — solo humano
        // ══════════════════════════════════════

        const esCubaBrasil =
            triggersCubaBrasil.some(t => txt.includes(norm(t))) ||
            (txt.includes("cup") && !txt.includes("usd") && !txt.includes("dolar") &&
             !txt.includes("real") && !txt.includes("brl") && !txt.includes("recibe")) ||
            txt.includes("mlc");

        if (esCubaBrasil) {
            const msg = "Perfecto 😊\n\nYordanys te atenderá enseguida para ayudarte con esa operación.\n\nPor favor aguarda un momento. 👌";
            await enviarSeguro(phone, msg);
            return msg;
        }

        // ══════════════════════════════════════
        // SALUDO ÚNICO
        // ══════════════════════════════════════

        const esSaludo = /^(hola|oi|bom dia|buenas|buenos dias|boa tarde|boa noite|buen dia|hey|hi|hello|e ai|eai|buenas tardes|buenas noches|good morning)[\s!?.]*$/.test(txt);

        if (esSaludo) {
            if (!yaSaludado) {
                const nombre = pushName ? `, ${pushName.split(" ")[0]}` : "";
                // Hora de Brasil (UTC-3)
                const horaBrasil = new Date(Date.now() - 3 * 60 * 60 * 1000).getUTCHours();
                let saludo;
                if (horaBrasil >= 6 && horaBrasil < 12) {
                    saludo = `Buenos días${nombre}! ☀️ ¿Cómo estás? ¿En qué te puedo ayudar hoy?`;
                } else if (horaBrasil >= 12 && horaBrasil < 18) {
                    saludo = `Buenas tardes${nombre}! 🌤️ ¿Cómo estás? ¿En qué te puedo ayudar?`;
                } else {
                    saludo = `Buenas noches${nombre}! 🌙 ¿Todo bien? Aquí estamos para lo que necesites.`;
                }
                await guardarCliente({ phone, saludoEnviado: true });
                await enviarSeguro(phone, saludo);
                return saludo;
            }
            // Ya saludado — retomar desde contexto actual
            if (cliente?.estado === "cotizacion_realizada" && cliente?.ultimo_monto) {
                const msg = `¿Continuamos con el envío de R$${cliente.ultimo_monto}? 💸`;
                await enviarSeguro(phone, msg);
                return msg;
            }
            if (cliente?.estado === "aguardando_comprovante") {
                await enviarSeguro(phone, esEs ? "Esperando tu comprobante 📎" : "Aguardando seu comprovante 📎");
                return "";
            }
            const msg = esEs ? "¿Cuánto quieres enviar? 😊" : "Quanto quer enviar? 😊";
            await enviarSeguro(phone, msg);
            return msg;
        }

        // ══════════════════════════════════════
        // FILTRO GATILLO — antes de cualquier lógica
        // Si no hay gatillo ni intención ni imagen
        // ni estado activo → silencio total
        // ══════════════════════════════════════

        const hayGatillo  = gatilhos.some(g => txt.includes(norm(g)));
        const hayNegocio  = palabrasNegocio.some(p => txt.includes(p));
        const hayEstado   = !!cliente?.estado;
        const hayImagen   = !!imageUrl;
        const esNumero    = /^\d+([.,]\d{1,2})?$/.test(txt.trim());
        const esSolo16    = txt.replace(/\D/g,"").length === 16;
        const esConfirma  = confirmaOperacion.includes(txt.trim());

        // Pasar solo si hay gatillo, negocio, estado activo, imagen, número o confirmación
        const debeResponder = hayGatillo || hayNegocio || hayEstado || hayImagen || esNumero || esSolo16 || esConfirma;
        if (!debeResponder) return "";

        // ══════════════════════════════════════
        // DERIVACIÓN HUMANO EXPLÍCITA
        // ══════════════════════════════════════

        if (/yordanys|hablar con alguien|operador|asesor humano|hablar con una persona/.test(txt)) {
            const msg = esEs ? "Yordanys te atiende enseguida 😊 👌" : "Yordanys te atende agora 😊 👌";
            await enviarSeguro(phone, msg);
            return msg;
        }

        if ((txt.includes("usd") || txt.includes("dolar")) &&
            (txt.includes("real") || txt.includes("brl") || txt.includes("brasil"))) {
            const msg = esEs ? "Eso lo maneja Yordanys directamente 😊 Te atenderá enseguida." : "Isso o Yordanys resolve 😊 Te atende já.";
            await enviarSeguro(phone, msg);
            return msg;
        }

        // ══════════════════════════════════════
        // IMÁGENES — procesamiento flexible
        // Acepta tarjeta o comprobante en cualquier orden
        // ══════════════════════════════════════

        if (imageUrl) {
            if (esPDF(imageUrl)) {
                // Verificar sesión activa si está esperando comprobante
                if (cliente?.estado === "aguardando_comprovante") {
                    const ref = cliente.fecha_pix || cliente.fecha_estado;
                    if (ref && Date.now() - new Date(ref).getTime() > DOS_HORAS) {
                        await limpiarSesion(phone);
                        await enviarSeguro(phone, "La sesión expiró ⚠️\n\nTu comprobante será revisado manualmente.");
                        return "";
                    }
                }
                const datos = await detectarComprobantePDF(imageUrl);
                if (datos.valido || datos.tipo === "comprovante_pdf") {
                    await procesarComprobante(phone, pushName, cliente, datos, esEs);
                } else {
                    await enviarSeguro(phone, esEs
                        ? "No pude leer el PDF 📄\n\nAsegúrate de que sea un comprobante de pago válido."
                        : "Não consegui ler o PDF 📄\n\nVerifique se é um comprovante válido."
                    );
                }
                return "";
            }

            const det = await detectarImagenUnificada(imageUrl);

            if (det.tipo === "tarjeta") {
                const num = String(det.tarjeta || "").replace(/\D/g, "");

                // BPA ilegible
                if (det.banco?.toLowerCase().includes("bpa") && num.startsWith("1239")) {
                    await enviarSeguro(phone, "No pude leer bien la imagen 📸\n\nEnvía una más clara o escribe los 16 dígitos.");
                    return "";
                }

                if (det.valida && /^\d{15,16}$/.test(num)) {
                    await guardarTarjeta(phone, num, det.titular, det.banco, cliente);

                    // Recargar cliente actualizado
                    const cli2 = await obtenerCliente(phone);

                    // Si ya hay comprobante pendiente → intentar completar directamente
                    if (cli2.comprobante_pendiente) {
                        const completado = await intentarCompletarOperacion(phone, pushName, cli2, esEs);
                        if (completado) return "";
                    }

                    const msg = cli2.ultimo_monto
                        ? `¡Tarjeta guardada! 💳\n\n¿Te envío el PIX para pagar R$${cli2.ultimo_monto}?`
                        : pick(CONFIRMA_TARJETA_SIN_MONTO);
                    await enviarSeguro(phone, msg);
                    return msg;
                }

                await enviarSeguro(phone, "No pude leer bien la imagen 📸\n\nEnvía una más clara o escribe los 16 dígitos.");
                return "";
            }

            if (det.tipo === "comprovante_pix") {
                await crm.onComprobanteRecibido(phone, esEs ? "es" : "pt");
                await procesarComprobante(phone, pushName, cliente, det, esEs);
                return "";
            }

            // Imagen no reconocida — silencio
            return "";
        }

        // ══════════════════════════════════════
        // LÓGICA DE TEXTO
        // ══════════════════════════════════════

        const soloNums = txt.replace(/\D/g, "");

        // ─────────────────────────────────────────
        // EXTRACCIÓN DE MONTO — mejorada
        //
        // Prioridad:
        //   1. Número precedido/seguido de señal monetaria
        //      "500 reais", "R$200", "200 reales", "100 usd", "50 dolares"
        //   2. Primer número standalone de 2-5 dígitos en contexto de negocio
        //   3. Nada — no asumir monto si el texto es ambiguo
        //
        // NO dispara monto si el texto solo tiene números de teléfono,
        // años, o códigos que no van acompañados de contexto de negocio.
        // ─────────────────────────────────────────

        // Señales monetarias explícitas junto al número
        const MONTO_MONETARIO = /(?:r\$|reais|reales|real|brl|usd|d[oó]lar(?:es)?|cup|mlc|pesos?|plata|dinero)\s*(\d{2,5})|\b(\d{2,5})\s*(?:r\$|reais|reales|real|brl|usd|d[oó]lar(?:es)?|cup|mlc|pesos?)/i;
        const matchMonetario = text.match(MONTO_MONETARIO);
        const valorMonetario = matchMonetario
            ? Number(matchMonetario[1] || matchMonetario[2])
            : null;

        // Número puro de 2-5 dígitos con contexto de envío (sin señal monetaria)
        const MONTO_CONTEXTUAL = /\b(\d{2,5})\b/g;
        let valorContextual = null;
        const CONTEXTO_ENVIO = /enviar|mandar|envio|cotiz|transfer|pagar|monto|quant|cuant|quanto|quiero/;
        if (!valorMonetario && CONTEXTO_ENVIO.test(txt)) {
            let m;
            while ((m = MONTO_CONTEXTUAL.exec(txt)) !== null) {
                const n = Number(m[1]);
                if (n >= 10 && n <= 50000) { valorContextual = n; break; }
            }
        }

        const valorFinal  = valorMonetario || valorContextual || null;
        const montoValido = valorFinal && valorFinal >= 10 && valorFinal <= 50000;
        // valor legacy — usado en algunos branches de USD abajo
        const valor = valorFinal;

        // — Selección de tarjeta cuando el bot preguntó cuál usar
        if (cliente?.estado === "seleccionando_tarjeta" && /^[1-9]$/.test(txt.trim())) {
            const tarjetas = Array.isArray(cliente?.tarjetas) ? cliente.tarjetas.filter(t => /^\d{15,16}$/.test(t)) : [];
            const idx = parseInt(txt.trim()) - 1;
            if (idx >= 0 && idx < tarjetas.length) {
                const tarjetaElegida = tarjetas[idx];
                await guardarCliente({
                    phone,
                    tarjeta: tarjetaElegida,
                    tarjeta_frecuente: tarjetaElegida,
                    estado: "aguardando_comprovante",
                    fechaEstado: new Date().toISOString(),
                    fechaPix: new Date().toISOString()
                });
                const cli2 = await obtenerCliente(phone);
                return await _enviarPIXFinal(phone, cli2, esEs);
            }
        }

        // — Selección de tipo cuando el bot lo preguntó
        if (cliente?.comprobante_pendiente && !cliente?.tipo_favorito && /^[123]$/.test(txt.trim())) {
            const mapasTipo = { "1": "brl_cup", "2": "usd_clasica", "3": "usd_prepago" };
            const tipoElegido = mapasTipo[txt.trim()];
            await guardarCliente({ phone, tipo: tipoElegido });
            const cli2 = await obtenerCliente(phone);
            await intentarCompletarOperacion(phone, pushName, cli2, esEs);
            return "";
        }

        // — Selección Clásica/Prepago cuando el bot preguntó por tipo USD
        if (cliente?.tipo_favorito === "usd_pendiente_tipo" && /^[12]$/.test(txt.trim())) {
            const tipoUSD = txt.trim() === "1" ? "usd_clasica" : "usd_prepago";
            const montoGuardado = Number(cliente?.ultimo_monto);
            if (montoGuardado > 0) {
                const r = await calcularOperacion({ tipo: tipoUSD, valor: montoGuardado });
                if (r) {
                    await guardarCliente({
                        phone, tipo: tipoUSD,
                        estado: "cotizacion_realizada",
                        fechaEstado: new Date().toISOString()
                    });
                    const ofertaUsd = await leerOferta();
                    const ofertaMsgUsd = ofertaUsd ? `\n\n🔥 *OFERTA:* ${ofertaUsd}` : "";
                    const res = `💵 ${montoGuardado} USD = ${fmt(r.cup)} CUP 🇨🇺${ofertaMsgUsd}\n\n${pick(CIERRES_COT)}`;
                    await enviarSeguro(phone, res);
                    return res;
                }
            }
        }

        // — Tarjeta por texto (15-16 dígitos, formato manual o con espacios/guiones)
        // Requiere que el mensaje sea SOLO la tarjeta: dígitos con separadores opcionales.
        // Rechaza si hay letras, palabras, o si el número podría ser un teléfono/monto.
        const esTarjetaTexto = (() => {
            // El texto original (sin normalizar) debe ser solo dígitos, espacios y guiones
            const rawTrim = text.trim();
            if (!/^[\d\s\-]+$/.test(rawTrim)) return false;
            // La parte numérica debe ser exactamente 15 o 16 dígitos
            const digits = rawTrim.replace(/[\s\-]/g, "");
            if (!/^\d{15,16}$/.test(digits)) return false;
            // No debe ser un número de teléfono (empieza con 55 + 11 dígitos)
            if (/^55\d{10,11}$/.test(digits)) return false;
            return digits;
        })();
        if (esTarjetaTexto) {
            await guardarTarjeta(phone, esTarjetaTexto, null, null, cliente);
            const cli2 = await obtenerCliente(phone);

            if (cli2.comprobante_pendiente) {
                const completado = await intentarCompletarOperacion(phone, pushName, cli2, esEs);
                if (completado) return "";
            }

            const msg = cli2.ultimo_monto
                ? `¡Tarjeta guardada! 💳\n\n¿Te envío el PIX para pagar R$${cli2.ultimo_monto}?`
                : pick(CONFIRMA_TARJETA_SIN_MONTO);
            await enviarSeguro(phone, msg);
            return msg;
        }

        // — Protección: bloque texto que parece número de tarjeta pero no aplica aquí
        // (ya se procesó arriba, si llegó aquí no es tarjeta)

        // — QR ilegible
        if (/no consigo escanear|no puedo escanear|no funciona el qr|qr no funciona|nao consigo|leer el qr/.test(txt)) {
            const key = getPIXKey(); const holder = getPIXHolder(); const bank = getPIXBank();
            const msg = key
                ? `No hay problema 😊\n\nCopia la clave PIX:\n\n${key}\n\nTitular: ${holder}\n🏦 ${bank}`
                : "Pídele la clave directamente a Yordanys 😊";
            await enviarSeguro(phone, msg);
            return msg;
        }

        // — Confirmación post-cotización
        if (esConfirma && cliente?.estado === "cotizacion_realizada") {
            if (!cliente.tarjeta && !cliente.tarjeta_frecuente) {
                await enviarSeguro(phone, "¡Genial! Solo me falta la tarjeta 💳\n\nEnvíame foto o los 16 dígitos.");
                return "";
            }
            await guardarCliente({ phone, estado: "aguardando_comprovante", fechaEstado: new Date().toISOString(), fechaPix: new Date().toISOString() });
            return await enviarPIX(phone, cliente, esEs);
        }

        // — Quiere pagar / PIX directo
        const quierePagar =
            /^(pix|pasame (el )?pix|enviame (el )?pix|manda(me)? (el )?pix|envia(me)? (el )?pix|quiero (pagar|hacerlo)|voy a pagar|fazer pix|hacer pix|manda pix|envia pix|send pix)$/.test(txt.trim()) ||
            /\b(quiero|voy a) (hacer|enviar|mandar)( el)? pix\b/.test(txt) ||
            /\bvoy a pagar\b/.test(txt);

        if (quierePagar) {
            const ref = cliente?.fecha_cotizacion || cliente?.updated_at;
            if (ref && Date.now() - new Date(ref).getTime() > DOS_HORAS) {
                await enviarSeguro(phone, esEs
                    ? "La cotización venció ⏰\n\nDime el monto de nuevo y te actualizo la tasa."
                    : "A cotação expirou ⏰\n\nMe diz o valor de novo."
                );
                return "";
            }

            // Si no tiene monto guardado, buscar en el mismo mensaje
            if (!cliente?.ultimo_monto || Number(cliente.ultimo_monto) <= 0) {
                const matchPix = txt.match(/\b(\d{2,5})\b/);
                const montoPix = matchPix ? Number(matchPix[1]) : null;
                if (montoPix && montoPix >= 10 && montoPix <= 50000) {
                    const r = await calcularOperacion({ tipo: "brl_cup", valor: montoPix });
                    if (r) {
                        await guardarCliente({
                            phone, nombre: pushName, monto: montoPix, tipo: "brl_cup",
                            estado: "aguardando_comprovante",
                            fechaEstado: new Date().toISOString(),
                            fechaPix: new Date().toISOString(),
                            fechaCotizacion: new Date().toISOString()
                        });
                        const cli2 = await obtenerCliente(phone);
                        return await enviarPIX(phone, cli2, esEs);
                    }
                }
            }

            return await enviarPIX(phone, cliente, esEs);
        }

        // — Comprobante verbal
        if (/paguei|pague|comprovante|comprobante|feito|realizado|ya envie|ya mande|ya pague|hice el pago/.test(txt)) {
            await enviarSeguro(phone, esEs
                ? "¡Perfecto! Mándame el comprobante (foto o PDF) 📎"
                : "Ótimo! Me manda o comprovante (foto ou PDF) 📎"
            );
            return "";
        }

        // — Consulta de tasas sin monto
        if (/a cuanto|a como|tasa.*hoy|cambio.*hoy|hoy.*cambio|hoy.*tasa|cual es la tasa|como esta el cambio|como esta la tasa|cuanto vale|cuanto esta|precio.*hoy|hoy.*precio|tasa de hoy|cambio de hoy/.test(txt)) {
            try {
                const pool = require("../../db");
                const r = await pool.query("SELECT * FROM rates LIMIT 1");
                const t = r.rows[0];
                if (t) {
                    const msg = `Tasas de hoy 💱\n\n🇧🇷 Reales → CUP\nHasta R$99: ${t.brl_0} CUP\nR$100–499: ${t.brl_100} CUP\nR$500–999: ${t.brl_500} CUP\nR$1000+: ${t.brl_1000} CUP\n\n💵 USD Clásica/Prepago: ${t.usd1} CUP\n\n¿Cuánto quieres enviar? 😊`;
                    await enviarSeguro(phone, msg);
                    return msg;
                }
            } catch (e) {
                console.error("❌ Error leyendo tasas:", e.message);
            }
        }

        // — Estado de operación
        if (/estado|mi operacion|mi envio|cuando llega|cuando llego|cuanto falta|ya llego|esta listo/.test(txt)) {
            const ultima = await obtenerUltimaOperacion(phone);
            if (!ultima) {
                await enviarSeguro(phone, "No encuentro operaciones registradas 🤔\n\n¿Quieres hacer un envío?");
                return "";
            }
            const est = ultima.status === "confirmada" ? "✅ Confirmada" : "⏳ Pendiente de validación";
            await enviarSeguro(phone, `Tu última operación: R$${ultima.monto} — ${est}`);
            return "";
        }

        // — Cotización USD
        // Requiere señal USD explícita + monto válido.
        // Si dice "reales" o "brl" junto a "usd" → deriva a Yordanys (USD→BRL, ya manejado arriba).
        // Detecta prepago/clásica por contexto; si no hay contexto, pregunta.
        const esUSD = (txt.includes("usd") || txt.includes("dolar") || txt.includes("dolares") || txt.includes("dólares"));
        if (montoValido && esUSD && !txt.includes("real") && !txt.includes("brl")) {
            const esEfectivo = /efectivo|cash|vender|cambiar|comprar/.test(txt);
            // Detectar tipo de tarjeta cubana mencionada
            const esPrepago  = /prepago|nauta|internacional/.test(txt);
            const esClasica  = /clasica|clásica|bpa|bandec|metropolitano/.test(txt);

            // Si no hay señal de tipo y no es efectivo → preguntar en lugar de asumir clásica
            if (!esEfectivo && !esPrepago && !esClasica) {
                const msgTipo = esEs
                    ? `💵 ${valorFinal} USD — ¿es para tarjeta Clásica o Prepago? 😊

1️⃣ Clásica (BPA/Bandec)
2️⃣ Prepago (Nauta/Internacional)`
                    : `💵 ${valorFinal} USD — é para cartão Clássico ou Pré-pago? 😊

1️⃣ Clássico (BPA/Bandec)
2️⃣ Pré-pago (Nauta/Internacional)`;
                await guardarCliente({
                    phone, nombre: pushName, monto: valorFinal, tipo: "usd_pendiente_tipo",
                    estado: "cotizacion_realizada",
                    fechaEstado: new Date().toISOString(),
                    fechaCotizacion: new Date().toISOString()
                });
                await crm.onCotizacion(phone, lang);
                await enviarSeguro(phone, msgTipo);
                return msgTipo;
            }

            const tipo = esEfectivo ? "usd_efectivo" : esPrepago ? "usd_prepago" : "usd_clasica";
            const r = await calcularOperacion({ tipo, valor });
            if (r) {
                await guardarCliente({
                    phone, nombre: pushName, monto: valorFinal, tipo,
                    estado: "cotizacion_realizada",
                    fechaEstado: new Date().toISOString(),
                    fechaCotizacion: new Date().toISOString()
                });
                await crm.onCotizacion(phone, lang);
                const ofertaUsd = await leerOferta();
                const ofertaMsgUsd = ofertaUsd ? `\n\n🔥 *OFERTA:* ${ofertaUsd}` : "";
                const res = tipo === "usd_efectivo"
                    ? `💵 ${valor} USD en efectivo = R$${fmt(r.brl ?? 0)} BRL${ofertaMsgUsd}\n\n${pick(CIERRES_COT)}`
                    : `💵 ${valor} USD = ${fmt(r.cup)} CUP 🇨🇺${ofertaMsgUsd}\n\n${pick(CIERRES_COT)}`;
                await enviarSeguro(phone, res);
                return res;
            }
        }

        // — Cotización BRL → CUP
        // Solo dispara si hay señal de negocio junto al monto:
        //   - monto precedido/seguido de "reais/reales/R$" (señal monetaria explícita), o
        //   - contexto de envío en el mensaje (quiero enviar, mandar, cotizar, etc.)
        //   - cliente ya en estado activo (cotizó antes, está esperando algo)
        const hayContextoBRL = (
            valorMonetario !== null ||          // número con señal monetaria explícita
            !!cliente?.estado ||                // cliente con flujo activo
            CONTEXTO_ENVIO.test(txt)            // mensaje con intención de envío
        );
        if (montoValido && hayContextoBRL &&
            !esUSD && !txt.includes("cup") && !txt.includes("mlc")
        ) {
            const r = await calcularOperacion({ tipo: "brl_cup", valor: valorFinal });
            if (r) {
                await guardarCliente({
                    phone, nombre: pushName, monto: valorFinal, tipo: "brl_cup",
                    estado: "cotizacion_realizada",
                    fechaEstado: new Date().toISOString(),
                    fechaCotizacion: new Date().toISOString()
                });
                await crm.onCotizacion(phone, lang);
                let tip = "";
                if (valorFinal < 100)       tip = "\n\n💡 Con R$100+ la tasa mejora.";
                else if (valorFinal < 500)  tip = "\n\n🔥 Con R$500+ la tasa sube otro escalón.";
                else if (valorFinal < 1000) tip = "\n\n🚀 Con R$1000+ obtienes la mejor tasa.";


                const oferta = await leerOferta();
                const ofertaMsg = oferta ? `\n\n🔥 *OFERTA:* ${oferta}` : "";
                const res = `💵 R$${valorFinal} = ${fmt(r.cup)} CUP 🇨🇺${tip}${ofertaMsg}\n\n${pick(CIERRES_COT)}`;
                await enviarSeguro(phone, res);
                return res;
            }
        }

        // — Monto fuera de rango → silencio
        if (valorFinal && !montoValido) return "";

        // — Intención Cuba sin monto
        if (txt.includes("cuba") && /dinero|enviar|mandar|pasar|plata|remesa/.test(txt)) {
            const nombre = pushName ? `, ${pushName.split(" ")[0]}` : "";
            await enviarSeguro(phone, `¡Hola${nombre}! 😊\n\n¿Cuánto quieres enviar a Cuba?`);
            return "";
        }

        // — Intención clara sin monto
        if (/quiero enviar|necesito enviar|quiero mandar|quiero hacer (una )?(remesa|transferencia)|necesito (una )?(remesa|transferencia)/.test(txt)) {
            await enviarSeguro(phone, "Perfecto 😊\n\n¿Cuánto deseas enviar?");
            return "";
        }

        // ══════════════════════════════════════
        // DESPEDIDA
        // ══════════════════════════════════════

        if (/^(gracias|ok gracias|hasta luego|chau|tchau|obrigado|obrigada|flw|valeu|até mais)[\s!.]*$/.test(txt.trim())) {
            const nombre = pushName ? `, ${pushName.split(" ")[0]}` : "";
            const msg = `¡Fue un placer${nombre}! 😊 Gracias por la confianza. Aquí estaremos cuando nos necesites. 👋`;
            await enviarSeguro(phone, msg);
            return msg;
        }

        // ══════════════════════════════════════
        // CIERRE INTELIGENTE
        // Si tiene monto + tarjeta y el mensaje
        // suena a intención de pago → PIX directo
        // sin pasar por GPT
        // ══════════════════════════════════════

        const tieneMontoDB   = Number(cliente?.ultimo_monto) > 0;
        const tieneTarjetaDB = !!(cliente?.tarjeta || cliente?.tarjeta_frecuente);

        // Cierre inteligente — SOLO si tiene monto Y tarjeta
        // Si falta el monto, no enviar PIX aunque diga "manda pix"
        if (tieneMontoDB && tieneTarjetaDB) {
            const intencionPago = /mismo|misma|llave|chave|transferir|depositar|proceder|continuar|reales|real|brl|r\$|envio el dinero|voy a pagar|quiero pagar/.test(txt);
            if (intencionPago) {
                await guardarCliente({
                    phone,
                    estado: "aguardando_comprovante",
                    fechaEstado: new Date().toISOString(),
                    fechaPix: new Date().toISOString()
                });
                return await enviarPIX(phone, cliente, esEs);
            }
        }

        // ══════════════════════════════════════
        // FLUJO DE RECARGA
        // ══════════════════════════════════════

        const esRecargaTexto = /recarga|recargar|recargas|recarga etecsa|recarga cuba|recargar telefono|recarga movil/.test(txt);

        if (esRecargaTexto && cliente?.estado !== "aguardando_numero_recarga" && cliente?.estado !== "aguardando_comprovante") {
            const recargas = await leerRecargas();
            if (recargas.length === 0) {
                await enviarSeguro(phone, "Por el momento no tenemos recargas disponibles. Pregunta a Yordanys 😊");
                return "";
            }
            let msg = "📱 *Tenemos dos tipos de recarga:*\n\n";
            recargas.forEach((r, i) => {
                const emoji = r.tipo === "nacional" ? "🇨🇺" : "🌍";
                msg += `${i + 1}️⃣ *Recarga ${r.tipo.charAt(0).toUpperCase() + r.tipo.slice(1)}*
`;
                msg += `${emoji} R$${r.precio}
`;
                msg += `${r.descripcion}

`;
            });
            msg += "¿Cuál prefieres? Responde *1* o *2* 😊";
            await guardarCliente({ phone, estado: "seleccionando_recarga", fechaEstado: new Date().toISOString() });
            await enviarSeguro(phone, msg);
            return msg;
        }

        // Selección de tipo de recarga
        if (cliente?.estado === "seleccionando_recarga" && /^[12]$/.test(txt.trim())) {
            const recargas = await leerRecargas();
            const idx = parseInt(txt.trim()) - 1;
            const recargaElegida = recargas[idx];
            if (!recargaElegida) {
                await enviarSeguro(phone, "Responde 1 o 2 😊");
                return "";
            }
            await guardarCliente({
                phone,
                monto: recargaElegida.precio,
                tipo: `recarga_${recargaElegida.tipo}`,
                estado: "aguardando_numero_recarga",
                fechaEstado: new Date().toISOString()
            });
            await enviarSeguro(phone, `Perfecto 😊

¿Cuál es el número cubano a recargar?

Ejemplo: 5XXXXXXX`);
            return "";
        }

        // Número cubano para recarga (8 dígitos que empiezan con 5)
        if (cliente?.estado === "aguardando_numero_recarga" && /^5\d{7}$/.test(soloNums)) {
            await guardarCliente({
                phone,
                tarjeta: soloNums, // reutilizamos tarjeta para guardar el número
                estado: "aguardando_comprovante",
                fechaEstado: new Date().toISOString(),
                fechaPix: new Date().toISOString()
            });
            return await enviarPIX(phone, await obtenerCliente(phone), esEs);
        }

        // ══════════════════════════════════════
        // ASISTENTE — solo para mensajes
        // conversacionales de 4+ palabras
        // ══════════════════════════════════════

        const palabras = txt.trim().split(/\s+/);
        if (palabras.length < 4 || /^\d+$/.test(txt.trim())) return "";

        try {
            const { texto, responseId } = await llamarAsistente(text, cliente?.last_response_id);
            if (texto) {
                await guardarCliente({ phone, lastResponseId: responseId });
                await enviarSeguro(phone, texto);
                return texto;
            }
        } catch (e) {
            console.error("❌ Asistente:", e.message);
        }

    } catch (e) {
        console.error("❌ procesarMensaje:", e.message);
    }
    return "";
}

module.exports = { detectarImagenUnificada, detectarComprobantePDF, procesarMensaje };
