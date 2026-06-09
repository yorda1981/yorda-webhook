require("dotenv").config();

const OpenAI = require("openai");
const pdfParse = require("pdf-parse");
console.log("✅ PDF-PARSE CARGADO");

const { enviarMensaje, enviarImagen } = require("./zapi");
const { calcularOperacion } = require("./calculator");
const { guardarCliente, obtenerCliente } = require("./customer-memory");
const { agregarOperacion, obtenerTodas } = require("./operations");

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ==========================================
// CONFIGURACIONES
// ==========================================

const DOS_HORAS = 2 * 60 * 60 * 1000;

const gatilhos = [
    "remesa", "transferencia", "transferir", "enviar dinero", "mandar dinero",
    "quiero enviar", "necesito enviar", "quiero mandar", "enviar a cuba",
    "mandar a cuba", "dinero para cuba", "envio", "tasa", "cotizacion",
    "cotizar", "cuanto recibe", "cuanto llega", "cuanto pagan",
    "cup", "peso cubano", "pesos cubanos", "usd", "dolar", "dolares",
    "recarga", "saldo", "pix", "clave pix", "qr pix",
    "tarjeta", "bpa", "bandec", "metropolitano",
    "quiero hacer una transferencia", "hacer una transferencia", "quiero una remesa",
    "necesito una remesa", "como envio dinero", "como mandar dinero",
    "quiero cotizar", "pasame el pix", "mandame el pix", "quiero hacer un envio",
    "me interesa enviar", "quiero pagar", "voy a pagar",
    "pasar dinero", "pasar un dinero", "quiero pasar dinero", "quiero pasar un dinero",
    "mandar plata", "enviar plata",
    "enviar para mi familia", "ayudar a mi familia",
    "enviar para cuba", "mandar para cuba"
];

const palabrasNegocio = [
    "cuba", "cup", "usd", "mlc", "transferencia", "remesa", "pix", "recarga", "etecsa", "tarjeta"
];

const confirmaOperacion = [
    "si", "sí", "ok", "dale", "vamos", "quiero hacerlo", "continuar",
    "deseo continuar", "de acuerdo", "hagamoslo", "hagámoslo",
    "vamos adelante", "continuemos"
];

function normalizarTexto(texto) {
    return String(texto || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function formatearNumero(numero) {
    return Number(numero).toLocaleString("es-ES");
}

// ==========================================
// HELPER: limpiar JSON de GPT
// ==========================================

function limpiarJSONGPT(texto) {
    try {
        return JSON.parse(
            String(texto || "")
                .replace(/```json/gi, "")
                .replace(/```/g, "")
                .trim()
        );
    } catch (e) {
        console.log("❌ Error parseando JSON GPT:", e.message);
        return {};
    }
}

// ==========================================
// HELPER: detectar si URL es PDF
// ✅ Tolerante con URLs sin extensión
// ==========================================

function esPDF(url) {
    if (!url) return false;
    const urlLower = url.toLowerCase();
    return urlLower.includes(".pdf") || urlLower.includes("mimetype=pdf") || urlLower.includes("type=pdf");
}

// ==========================================
// DETECCIÓN DE TARJETA EN IMAGEN
// gpt-4o para mayor precisión
// Log OCR bruto antes del parse
// ==========================================

async function detectarTarjetaEnImagen(imageUrl) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `Analiza la imagen y responde EXCLUSIVAMENTE en JSON.\n\nFormato:\n\n{\n  "tarjeta": "numerosintarjeta",\n  "titular": "nombre del titular",\n  "banco": "nombre del banco",\n  "valida": true\n}\n\nReglas:\n- tarjeta debe contener únicamente los números sin espacios ni guiones (puede tener 15 o 16 dígitos).\n- titular debe contener el nombre visible en mayúsculas.\n- banco debe contener el nombre del banco.\n- valida debe ser true si encontraste una tarjeta real, false si no.\n- si algún dato no existe usar null.\n- no agregues texto fuera del JSON.`
                        },
                        {
                            type: "image_url",
                            image_url: { url: imageUrl }
                        }
                    ]
                }
            ],
            max_tokens: 120
        });

        const rawContent = response.choices?.[0]?.message?.content;
        console.log("TARJETA GPT RAW:", rawContent);

        const resultado = limpiarJSONGPT(rawContent);
        console.log("TARJETA GPT:", resultado);
        return resultado;
    } catch (error) {
        console.error("❌ Error detectando tarjeta:", error.message);
        return {};
    }
}

// ==========================================
// DETECCIÓN UNIFICADA: TARJETA O COMPROBANTE PIX
// Una sola llamada gpt-4o, sin clasificarImagen() separado
// Detectar clave PIX como destino_correcto
// ==========================================

async function detectarImagenUnificada(imageUrl) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `Analiza la imagen y determina si es una tarjeta bancaria o un comprobante de pago PIX. Responde EXCLUSIVAMENTE en JSON.\n\nSi es una TARJETA BANCARIA:\n{\n  "tipo": "tarjeta",\n  "tarjeta": "numerosintarjeta",\n  "titular": "NOMBRE DEL TITULAR",\n  "banco": "nombre del banco",\n  "valida": true\n}\n\nSi es un COMPROBANTE PIX:\n{\n  "tipo": "comprovante_pix",\n  "valor": 200,\n  "fecha": "DD/MM/AAAA",\n  "hora": "HH:MM",\n  "banco": "nombre del banco origen",\n  "destinatario": "nombre del destinatario",\n  "destino_correcto": true,\n  "valido": true\n}\n\nSi es OTRA COSA:\n{\n  "tipo": "otro"\n}\n\nReglas generales:\n- Para tarjeta: incluir solo los dígitos sin espacios (15 o 16 dígitos aceptados).\n- Para comprobante: valor debe ser un número sin símbolos (ej: 200, no "R$200,00").\n- destino_correcto debe ser true si el destinatario contiene alguno de estos nombres (en cualquier capitalización): Yordanys, Yordanys Rafael, Yordanys Rafael Sosa Reyes, Yordanys R S Reyes, Yordanys Sosa Reyes, Yordanys Reyes, YORDANYS R S REYES, YORDANYS RAFAEL SOSA REYES, Y R S REYES, YORDANYS REYES.\n- destino_correcto también debe ser true si encuentras la clave PIX: 8becaaf5-f296-4cbc-a115-46e3d23b042a\n- si algún dato no existe usar null.\n- no agregues texto fuera del JSON.`
                        },
                        {
                            type: "image_url",
                            image_url: { url: imageUrl }
                        }
                    ]
                }
            ],
            max_tokens: 220
        });

        const rawContent = response.choices?.[0]?.message?.content;
        console.log("IMAGEN UNIFICADA GPT RAW:", rawContent);

        const resultado = limpiarJSONGPT(rawContent);
        console.log("IMAGEN UNIFICADA GPT:", resultado);
        return resultado;
    } catch (error) {
        console.error("❌ Error en detección unificada:", error.message);
        return { tipo: "otro" };
    }
}

// ==========================================
// DETECCIÓN DE COMPROBANTE PDF
// Detectar clave PIX en PDF también
// ==========================================

async function detectarComprobantePDF(pdfUrl) {
    try {
        console.log("📄 Descargando PDF:", pdfUrl);
        const response = await fetch(pdfUrl);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const data = await pdfParse(buffer);
        const textoPDF = data.text;
        console.log("📄 TEXTO PDF:\n", textoPDF);

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
                    content: `Analiza el siguiente texto de un comprobante de pago y responde EXCLUSIVAMENTE en JSON.\n\nTexto:\n${textoPDF}\n\nFormato:\n\n{\n  "tipo": "comprovante_pdf",\n  "valor": 200,\n  "fecha": "DD/MM/AAAA",\n  "hora": "HH:MM",\n  "banco": "nombre del banco origen",\n  "destinatario": "nombre del destinatario",\n  "destino_correcto": true,\n  "valido": true\n}\n\nReglas:\n- valor debe ser un número sin símbolos (ej: 200, no "R$200,00").\n- destino_correcto debe ser true si el destinatario contiene alguno de estos nombres (en cualquier capitalización): Yordanys, Yordanys Rafael, Yordanys Rafael Sosa Reyes, Yordanys R S Reyes, Yordanys Sosa Reyes, Yordanys Reyes, YORDANYS R S REYES, YORDANYS RAFAEL SOSA REYES, Y R S REYES, YORDANYS REYES.\n- destino_correcto también debe ser true si el texto contiene la clave PIX: 8becaaf5-f296-4cbc-a115-46e3d23b042a\n- valido debe ser true si es un comprobante de pago real.\n- si algún dato no existe usar null.\n- no agregues texto fuera del JSON.`
                }
            ],
            max_tokens: 200
        });

        const datos = limpiarJSONGPT(completion.choices?.[0]?.message?.content);
        console.log("📄 COMPROBANTE PDF ANALIZADO:", datos);
        return datos;
    } catch (error) {
        console.error("❌ Error leyendo PDF:", error.message);
        return {};
    }
}

// ==========================================
// HELPERS AUXILIARES
// ==========================================

async function enviarSeguro(phone, mensaje) {
    if (!mensaje) {
        console.warn("⚠️ ENVÍO BLOQUEADO — mensaje undefined o vacío");
        return;
    }
    console.log("📤 ENVIANDO:", mensaje);
    await enviarMensaje(phone, mensaje);
}

async function limpiarSesion(phone) {
    await guardarCliente({
        phone,
        monto: null,
        estado: null,
        fechaEstado: null,
        fechaPix: null,
        fechaCotizacion: null
    });
    console.log("✅ SESIÓN CERRADA:", phone);
}

// ==========================================
// PROCESAR COMPROBANTE (reutilizable)
// ==========================================

async function procesarComprobanteConfirmado(phone, pushName, cliente, datosComprobante, esEspanol) {
    if (datosComprobante.destino_correcto === false) {
        await enviarSeguro(
            phone,
            "⚠️ El comprobante no corresponde a nuestra cuenta. Por favor verifique el destinatario y envíe el comprobante correcto."
        );
        return "";
    }

    const operaciones = await obtenerTodas();
    const operacionPendiente = operaciones
        .filter(op => op.phone === phone && op.status === "pendiente")
        .sort((a, b) => b.id - a.id)[0];

    if (
        operacionPendiente &&
        datosComprobante.valor &&
        Math.round(Number(datosComprobante.valor)) !== Math.round(Number(operacionPendiente.monto))
    ) {
        await enviarSeguro(
            phone,
            `⚠️ El valor del comprobante (R$${datosComprobante.valor}) no coincide con la operación (R$${operacionPendiente.monto}). Por favor verifique.`
        );
        return "";
    }

    if (cliente.ultimo_monto > 0) {
        const yaExisteMismoMonto = operaciones.find(op =>
            op.phone === phone &&
            op.status === "pendiente" &&
            Number(op.monto) === Number(cliente.ultimo_monto)
        );
        if (yaExisteMismoMonto) return "";

        if (!cliente.tarjeta && !cliente.tarjeta_frecuente) {
            await enviarSeguro(
                phone,
                esEspanol
                    ? "⚠️ Primero envíe una foto de la tarjeta de destino para poder procesar la operación."
                    : "⚠️ Primeiro envie uma foto do cartão de destino para processar a operação."
            );
            return "";
        }

        const resultado = await calcularOperacion({
            tipo: cliente.tipo_favorito,
            valor: cliente.ultimo_monto
        });

        await agregarOperacion({
            phone,
            nombre: pushName || cliente.nombre || "Cliente",
            monto: cliente.ultimo_monto,
            cup: resultado?.cup || 0,
            tarjeta: cliente.tarjeta || cliente.tarjeta_frecuente || "",
            titular: cliente.titular || cliente.titular_frecuente || "",
            banco: cliente.banco_detectado || cliente.bancoDetectado || "",
            tipo: cliente.tipo_favorito
        });

        await enviarSeguro(
            phone,
            `📥 NUEVA OPERACIÓN PENDIENTE\n\n👤 Cliente: ${pushName || cliente.nombre}\n\n📱 Teléfono: ${phone}\n\n💵 Enviado: R$${cliente.ultimo_monto}\n\n🇨🇺 Recibe: ${formatearNumero(resultado?.cup || 0)} CUP\n\n🏦 Banco: ${cliente.banco_detectado || cliente.bancoDetectado || "-"}\n\n💳 Tarjeta:\n${cliente.tarjeta || cliente.tarjeta_frecuente || "-"}\n\n👤 Titular:\n${cliente.titular || cliente.titular_frecuente || "-"}\n\n⏳ Estado:\nPendiente de validación`
        );

        await limpiarSesion(phone);
        return "";
    }

    const respuesta = esEspanol
        ? "Perfecto 😊\nRecibimos tu comprobante. Procesaremos tu envío enseguida."
        : "Perfeito 😊\nRecebemos seu comprovante. Processaremos seu envio imediatamente.";
    await enviarSeguro(phone, respuesta);
    return respuesta;
}

// ==========================================
// PROCESAR MENSAJE
// ==========================================

async function procesarMensaje(phone, text, pushName = "", imageUrl = null) {
    console.log("NOMBRE CLIENTE:", pushName);
    if (imageUrl) console.log("🖼️ imageUrl recibida:", imageUrl);

    try {
        if (!text || !phone) return "";

        const texto = normalizarTexto(text);
        const esEspanol = /hola|buenas|buenos dias|buen dia|quiero|cuanto|enviar|mandar|giro|transferencia|dinero|cuba|pesos|cup|reales|usd|dolares|dolar/i.test(texto);

        const cliente = await obtenerCliente(phone);

        // ✅ Confirmación post-cotización
        if (
            cliente?.estado === "cotizacion_realizada" &&
            confirmaOperacion.includes(texto.trim())
        ) {
            if (!cliente.tarjeta && !cliente.tarjeta_frecuente) {
                await enviarSeguro(
                    phone,
                    "Perfecto 😊\n\nVoy a ayudarte con el envío.\n\nPuedes enviarme una foto de la tarjeta o los datos de destino y continuamos enseguida. 👌"
                );
                return "";
            }

            const llavePix = process.env.PIX_KEY || "8becaaf5-f296-4cbc-a115-46e3d23b042a";

            await guardarCliente({
                phone,
                estado: "aguardando_comprovante",
                fechaEstado: new Date().toISOString(),
                fechaPix: new Date().toISOString()
            });

            await enviarImagen(
                phone,
                "https://yorda-webhook-production.up.railway.app/pix.jpg.png",
                "📲 Escanee el QR PIX para realizar el pago."
            );
            await enviarSeguro(phone, llavePix);
            await enviarSeguro(phone, "Titular: Yordanys Rafael Sosa Reyes\n🏦 Nubank");
            await enviarSeguro(
                phone,
                esEspanol ? "Después del pago, envíe el comprobante." : "Após o pagamento, envie o comprovante."
            );
            return llavePix;
        }

        // Derivación directa y protección humana
        if (
            /yordanys|humano|asesor|tengo cup|dinero en cuba|enviar para brasil|traer para brasil|vender cup|cup por reales/i.test(texto) ||
            ((texto.includes("usd") || texto.includes("dolar") || texto.includes("dolares")) && (texto.includes("real") || texto.includes("brl") || texto.includes("brasil"))) ||
            (texto.includes("cup") && !texto.includes("real") && !texto.includes("usd") && !texto.includes("dolar") && !texto.includes("dolares")) ||
            texto.includes("mlc")
        ) {
            const respuesta = esEspanol
                ? "Perfecto 😊\nYordanys te atenderá enseguida para darte las tasas cambio exacta de esa operación. 👌"
                : "Perfeito 😊\nYordanys irá atendê-lo imediatamente para lhe dar a cotação exata dessa operação. 👌";
            await enviarSeguro(phone, respuesta);
            return respuesta;
        }

        const soloNumeros = texto.replace(/\D/g, "");
        const valor = soloNumeros.length > 0 ? Number(soloNumeros) : null;

        // ✅ Tarjeta por texto (16 dígitos)
        if (soloNumeros.length === 16) {
            const tarjetasActuales = Array.isArray(cliente?.tarjetas) ? cliente.tarjetas : [];
            if (!tarjetasActuales.includes(soloNumeros)) tarjetasActuales.push(soloNumeros);

            await guardarCliente({
                phone,
                tarjeta: soloNumeros,
                tarjeta_frecuente: soloNumeros,
                tarjetas: tarjetasActuales
            });

            if (!cliente?.ultimo_monto) {
                await enviarSeguro(phone, "Perfecto 😊\n\nYa recibí los datos de destino.\n\n¿Cuánto deseas enviar?");
                return "";
            }

            await enviarSeguro(phone, "Perfecto 😊\n\nYa recibí los datos de destino.\n\nSi deseas continuar puedo enviarte el PIX. 👌");
            return "";
        }

        const esMontoValido = valor && valor >= 10 && valor <= 50000;

        if (
            esMontoValido &&
            (texto.includes("real") || texto.includes("reales") || texto.includes("r$")) &&
            cliente?.estado === "aguardando_comprovante"
        ) {
            await guardarCliente({
                phone,
                nombre: pushName,
                monto: valor,
                tipo: "brl_cup",
                estado: "cotizacion_realizada",
                fechaEstado: new Date().toISOString(),
                fechaCotizacion: new Date().toISOString()
            });
        }

        // Caso QR ilegible
        if (/no consigo escanear|nao consigo escanear|no puedo escanear|no funciona el qr|qr no funciona|escanear/i.test(texto)) {
            const llaveFallback = process.env.PIX_KEY || "8becaaf5-f296-4cbc-a115-46e3d23b042a";
            const msg = `No hay problema 😊\n\nTambién puede copiar y pegar la clave PIX:\n\n${llaveFallback}\n\nTitular: Yordanys Rafael Sosa Reyes\n🏦 Nubank`;
            await enviarSeguro(phone, msg);
            return msg;
        }

        // ✅ quierePagar
        const quierePagar =
            /^(pix|envia el pix|envía el pix|envia pix|envía pix|pasame el pix|pásame el pix|quiero hacerlo|voy a pagar|hacer pix|fazer pix|ok|dale|vamos|de acuerdo|hagamoslo|hagámoslo)$/
            .test(texto.trim()) ||
            /\bquiero (hacer|enviar|mandar) (el )?pix\b/.test(texto) ||
            /\bvoy a (pagar|hacer|enviar)\b/.test(texto);

        if (quierePagar) {
            if (!cliente || !cliente.ultimo_monto || cliente.ultimo_monto <= 0) {
                const msg = esEspanol
                    ? "Primero indícame el monto que deseas enviar. 😊"
                    : "Primeiro informe o valor que deseja enviar. 😊";
                await enviarSeguro(phone, msg);
                return msg;
            }

            const ahora = Date.now();
            const fechaCotRef = cliente.fecha_cotizacion || cliente.updated_at;
            if (ahora - new Date(fechaCotRef).getTime() > DOS_HORAS) {
                const msgVencido = esEspanol
                    ? "La cotización anterior ha vencido. Indícame nuevamente el monto para actualizar la tasa. 📈"
                    : "A cotação anterior expirou. Informe novamente o valor para atualizar a taxa. 📈";
                await enviarSeguro(phone, msgVencido);
                return msgVencido;
            }

            const llavePix = process.env.PIX_KEY || "8becaaf5-f296-4cbc-a115-46e3d23b042a";

            await guardarCliente({
                phone,
                estado: "aguardando_comprovante",
                fechaEstado: new Date().toISOString(),
                fechaPix: new Date().toISOString()
            });

            await enviarImagen(
                phone,
                "https://yorda-webhook-production.up.railway.app/pix.jpg.png",
                "📲 Escanee el QR PIX para realizar el pago."
            );
            await enviarSeguro(phone, llavePix);
            await enviarSeguro(phone, "Titular: Yordanys Rafael Sosa Reyes\n🏦 Nubank");
            await enviarSeguro(
                phone,
                esEspanol ? "Después del pago, envíe el comprobante." : "Após o pagamento, envie o comprovante."
            );
            return llavePix;
        }

        // ==========================================
        // MANEJO DE IMÁGENES
        // ==========================================

        if (imageUrl) {
            // ✅ PRIORIDAD ABSOLUTA: comprobante si estado es aguardando
            if (cliente?.estado === "aguardando_comprovante") {
                const ahora = Date.now();
                const fechaPixRef = cliente.fecha_pix || cliente.fecha_estado;
                if (ahora - new Date(fechaPixRef).getTime() > DOS_HORAS) {
                    await limpiarSesion(phone);
                    await enviarSeguro(
                        phone,
                        "⚠️ Hemos recibido su comprobante, pero la sesión había expirado. Será revisado manualmente."
                    );
                    return "";
                }

                let datosComprobante = {};
                if (esPDF(imageUrl)) {
                    datosComprobante = await detectarComprobantePDF(imageUrl);
                } else {
                    const datos = await detectarImagenUnificada(imageUrl);
                    if (datos.tipo === "comprovante_pix") {
                        datosComprobante = datos;
                    } else if (datos.tipo === "tarjeta" && datos.valida) {
                        const tarjetaLimpia = String(datos.tarjeta || "").replace(/\D/g, "");
                        if (/^\d{15,16}$/.test(tarjetaLimpia)) {
                            const tarjetasActuales = Array.isArray(cliente?.tarjetas) ? cliente.tarjetas : [];
                            if (!tarjetasActuales.includes(tarjetaLimpia)) tarjetasActuales.push(tarjetaLimpia);
                            await guardarCliente({
                                phone,
                                tarjeta: tarjetaLimpia,
                                titular: datos.titular || "",
                                bancoDetectado: datos.banco || "",
                                tarjeta_frecuente: tarjetaLimpia,
                                titular_frecuente: datos.titular || "",
                                banco_detectado: datos.banco || "",
                                tarjetas: tarjetasActuales
                            });
                            await enviarSeguro(
                                phone,
                                "Perfecto 😊\n\nYa guardé los datos de la tarjeta.\n\nAhora envía el comprobante del pago PIX para completar la operación. 👌"
                            );
                            return "";
                        }
                    }
                    if (!datosComprobante.valido && datos.tipo !== "comprovante_pix") return "";
                }

                return await procesarComprobanteConfirmado(phone, pushName, cliente, datosComprobante, esEspanol);
            }

            // ✅ Imagen fuera de estado aguardando_comprovante
            if (!esPDF(imageUrl)) {
                const datos = await detectarImagenUnificada(imageUrl);

                if (datos.tipo === "tarjeta") {
                    const tarjetaLimpia = String(datos.tarjeta || "").replace(/\D/g, "");

                    if (datos.banco && datos.banco.toLowerCase().includes("bpa") && tarjetaLimpia.startsWith("1239")) {
                        await enviarSeguro(
                            phone,
                            "⚠️ No pude leer correctamente la imagen.\n\nPor favor envíe una foto más clara o escriba los datos manualmente."
                        );
                        return "";
                    }

                    if (datos.valida && /^\d{15,16}$/.test(tarjetaLimpia)) {
                        const tarjetasActuales = Array.isArray(cliente?.tarjetas) ? cliente.tarjetas : [];
                        if (!tarjetasActuales.includes(tarjetaLimpia)) tarjetasActuales.push(tarjetaLimpia);

                        await guardarCliente({
                            phone,
                            tarjeta: tarjetaLimpia,
                            titular: datos.titular || "",
                            bancoDetectado: datos.banco || "",
                            tarjeta_frecuente: tarjetaLimpia,
                            titular_frecuente: datos.titular || "",
                            banco_detectado: datos.banco || "",
                            tarjetas: tarjetasActuales
                        });

                        if (!cliente?.ultimo_monto) {
                            await enviarSeguro(phone, "Perfecto 😊\n\nYa recibí los datos de destino.\n\n¿Cuánto deseas enviar?");
                        } else {
                            await enviarSeguro(phone, "Perfecto 😊\n\nYa recibí los datos de destino.\n\nSi deseas continuar puedo enviarte el PIX. 👌");
                        }
                        return "";
                    }

                    await enviarSeguro(
                        phone,
                        "⚠️ No pude leer correctamente la imagen.\n\nPor favor envíe una foto más clara o escriba los datos manualmente."
                    );
                    return "";
                }

                if (datos.tipo === "comprovante_pix") {
                    await enviarSeguro(
                        phone,
                        "⚠️ Recibimos el comprobante pero no hay una operación activa. Si ya realizó el pago, indícanos el monto enviado."
                    );
                    return "";
                }

                // Imagen no reconocida → silencio total
                return "";
            }

            // PDF fuera de flujo → silencio
            return "";
        }

        // ==========================================
        // FLUJO DE TEXTO PURO
        // ==========================================

        // Comprobante por texto
        const textoIndicaComprobante = /paguei|pague|comprovante|comprobante|feito|realizado|ya envie|ya mande/i.test(texto);
        if (textoIndicaComprobante && cliente?.estado === "aguardando_comprovante") {
            const respuesta = esEspanol
                ? "Perfecto 😊\nRecibimos tu comprobante. Procesaremos tu envío enseguida."
                : "Perfeito 😊\nRecebemos seu comprovante. Processaremos seu envio imediatamente.";
            await enviarSeguro(phone, respuesta);
            return respuesta;
        }

        // ==========================================
        // COTIZACIONES USD
        // ✅ Detectar tipo correcto: usd_efectivo vs usd_prepago vs usd_clasica
        // ==========================================

        if (esMontoValido && (texto.includes("usd") || texto.includes("dolar") || texto.includes("dolares")) && !texto.includes("real") && !texto.includes("brl")) {

            const esUsdEfectivo =
                texto.includes("efectivo") ||
                texto.includes("cash") ||
                texto.includes("vender") ||
                texto.includes("cambiar");

            const tipoUsd = esUsdEfectivo
                ? "usd_efectivo"
                : texto.includes("prepago")
                    ? "usd_prepago"
                    : "usd_clasica";

            const resultado = await calcularOperacion({ tipo: tipoUsd, valor });

            if (resultado) {
                await guardarCliente({
                    phone,
                    nombre: pushName,
                    monto: valor,
                    tipo: tipoUsd,
                    estado: "cotizacion_realizada",
                    fechaEstado: new Date().toISOString(),
                    fechaCotizacion: new Date().toISOString()
                });

                let respuesta;
                if (tipoUsd === "usd_efectivo") {
                    const brl = resultado.brl ?? resultado.cup ?? 0;
                    respuesta = `💵 ${valor} USD en efectivo hoy serían R$${formatearNumero(brl)} BRL 🇧🇷\n\n¿Deseas continuar?`;
                } else {
                    respuesta = `💵 ${valor} USD hoy serían ${formatearNumero(resultado.cup)} CUP 🇨🇺\n\n¿Deseas continuar?`;
                }

                await enviarSeguro(phone, respuesta);
                return respuesta;
            }
        }

        // ==========================================
        // COTIZACIONES BRL → CUP
        // ==========================================

        if (esMontoValido && !texto.includes("usd") && !texto.includes("dolar") && !texto.includes("dolares") && !texto.includes("cup") && !texto.includes("mlc")) {
            const resultado = await calcularOperacion({ tipo: "brl_cup", valor });

            if (resultado) {
                await guardarCliente({
                    phone,
                    nombre: pushName,
                    monto: valor,
                    tipo: "brl_cup",
                    estado: "cotizacion_realizada",
                    fechaEstado: new Date().toISOString(),
                    fechaCotizacion: new Date().toISOString()
                });

                let mensajeExtra = "";
                if (valor < 100) {
                    mensajeExtra = "\n\n💡 A partir de R$100 la tasa mejora y recibes más CUP.";
                } else if (valor >= 100 && valor < 500) {
                    mensajeExtra = "\n\n🔥 A partir de R$500 la tasa vuelve a mejorar.";
                } else if (valor >= 500 && valor < 1000) {
                    mensajeExtra = "\n\n🚀 A partir de R$1000 obtienes nuestra mejor tasa.";
                }

                const respuesta = `💵 R$${valor} hoy serían ${formatearNumero(resultado.cup)} CUP 🇨🇺${mensajeExtra}\n\n¿Deseas realizar la operación ahora?`;
                await enviarSeguro(phone, respuesta);
                return respuesta;
            }
        }

        if (valor && !esMontoValido) return "";

        // ✅ FILTRADO ULTRA-SEGURO
        const activarPorFrase = gatilhos.some(g => texto.includes(normalizarTexto(g)));
        const activarPorPalabra = palabrasNegocio.some(p => texto.includes(p));

        if (!activarPorFrase && !activarPorPalabra) return "";

        // ✅ Intención de remesa clara hacia Cuba
        if (
            texto.includes("cuba") &&
            (texto.includes("dinero") || texto.includes("enviar") || texto.includes("mandar") || texto.includes("pasar") || texto.includes("plata"))
        ) {
            const msg = "Perfecto 😊\n\n¿Cuánto deseas enviar?";
            await enviarSeguro(phone, msg);
            return msg;
        }

        // ✅ GPT conversacional — solo texto, con system prompt estricto
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `Eres YordaBot, un asistente especializado en remesas de Brasil a Cuba.
Responde ÚNICAMENTE sobre: envío de dinero a Cuba, cotizaciones BRL/CUP/USD, recargas, transferencias.
Si el cliente pregunta algo fuera de ese tema, responde EXACTAMENTE esto (sin modificar):
"Perfecto 😊\n\n¿Deseas enviar dinero a Cuba, realizar una recarga o consultar una transferencia?"
Si el cliente quiere hablar con un humano o asesor, confirma que Yordanys lo atenderá.
No inventes respuestas. No digas "Hola soy YordaBot". No hagas preguntas ambiguas.`
                },
                { role: "user", content: text }
            ],
            temperature: 0.2,
            max_tokens: 100
        });

        const respuestaIA = completion?.choices?.[0]?.message?.content?.trim();
        if (respuestaIA) {
            await enviarSeguro(phone, respuestaIA);
            return respuestaIA;
        }

    } catch (error) {
        console.error("❌ Error en procesarMensaje:", error.message);
        return "";
    }
}

module.exports = { detectarTarjetaEnImagen, detectarImagenUnificada, detectarComprobantePDF, procesarMensaje };
