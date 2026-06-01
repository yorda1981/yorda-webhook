require("dotenv").config();

const OpenAI = require("openai");
const pdfParse = require("pdf-parse"); // ✅ NUEVO
console.log("✅ PDF-PARSE CARGADO");   // ✅ NUEVO

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

const gatilhos = ["yordanys", "asesor", "humano", "ayuda", "informacion", "contacto"];

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
// DETECCIÓN DE TARJETA EN IMAGEN
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
                            text: `Analiza la imagen y responde EXCLUSIVAMENTE en JSON.\n\nFormato:\n\n{\n  "tarjeta":"numero de 16 digitos",\n  "titular":"nombre del titular",\n  "banco":"nombre del banco"\n}\n\nReglas:\n- tarjeta debe contener únicamente los 16 números.\n- titular debe contener el nombre visible.\n- banco debe contener el nombre del banco.\n- si algún dato no existe usar null.\n- no agregues texto fuera del JSON.`
                        },
                        {
                            type: "image_url",
                            image_url: { url: imageUrl }
                        }
                    ]
                }
            ],
            max_tokens: 100
        });

        return response.choices?.[0]?.message?.content?.trim();
    } catch (error) {
        console.error("❌ Error detectando tarjeta:", error.message);
        return null;
    }
}

// ==========================================
// DETECCIÓN DE COMPROBANTE PIX (imagen)
// ==========================================

async function detectarComprobantePIX(imageUrl) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `Analiza la imagen y responde EXCLUSIVAMENTE en JSON.\n\nFormato:\n\n{\n  "tipo": "comprovante_pix",\n  "valor": "monto con decimales",\n  "fecha": "DD/MM/AAAA",\n  "hora": "HH:MM",\n  "banco": "nombre del banco origen",\n  "destinatario": "nombre del destinatario"\n}\n\nReglas:\n- valor debe ser el monto transferido, con decimales (ej: "130.00").\n- fecha en formato DD/MM/AAAA.\n- hora en formato HH:MM.\n- banco es el banco desde el que se realizó el pago.\n- destinatario es el nombre de quien recibió el pago.\n- si algún dato no existe o no se ve, usar null.\n- no agregues texto fuera del JSON.`
                        },
                        {
                            type: "image_url",
                            image_url: { url: imageUrl }
                        }
                    ]
                }
            ],
            max_tokens: 150
        });

        return response.choices?.[0]?.message?.content?.trim();
    } catch (error) {
        console.error("❌ Error detectando comprobante PIX:", error.message);
        return null;
    }
}

// ==========================================
// DETECCIÓN DE COMPROBANTE PDF (V1 - Solo logs) ✅ NUEVO
// ==========================================

async function detectarComprobantePDF(pdfUrl) {
    try {
        console.log("📄 Descargando PDF:", pdfUrl);

        const response = await fetch(pdfUrl);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const data = await pdfParse(buffer);
        const texto = data.text;

        console.log("📄 TEXTO PDF:\n", texto);

        return texto;
    } catch (error) {
        console.error("❌ Error leyendo PDF:", error.message);
        return null;
    }
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

        // 1. DETECCIÓN DE IDIOMA
        const esEspanol = /hola|buenas|buenos dias|buen dia|quiero|cuanto|enviar|mandar|giro|transferencia|dinero|cuba|pesos|cup|reales|usd|dolares|dolar/i.test(texto);

        // 2. MEMORIA DE CLIENTE
        const cliente = await obtenerCliente(phone);

        // 3. ATENCIÓN HUMANA
        if (
            /yordanys|humano|asesor|tengo cup|dinero en cuba|enviar para brasil|traer para brasil|vender cup|cup por reales/i.test(texto) ||
            ((texto.includes("usd") || texto.includes("dolar") || texto.includes("dolares")) && (texto.includes("real") || texto.includes("brl") || texto.includes("brasil"))) ||
            (texto.includes("cup") && !texto.includes("real") && !texto.includes("usd") && !texto.includes("dolar") && !texto.includes("dolares")) ||
            texto.includes("mlc")
        ) {
            const respuesta = esEspanol
                ? "Perfecto 😊\nYordanys te atenderá enseguida para darte la cotización exacta de esa operación. 👌"
                : "Perfeito 😊\nYordanys irá atendê-lo imediatamente para lhe dar a cotação exata dessa operação. 👌";
            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // VALIDACIÓN DE NÚMEROS (Tarjetas vs Montos)
        const soloNumeros = texto.replace(/\D/g, "");
        const valor = soloNumeros.length > 0 ? Number(soloNumeros) : null;

        if (soloNumeros.length === 16) {
            console.log("💳 Tarjeta detectada por texto, guardando silencio.");
            await guardarCliente({ phone, tarjeta: soloNumeros });
            return "";
        }

        const esMontoValido = valor && valor >= 10 && valor <= 50000;

        // ---------------------------------------------------------
        // 4. LÓGICA DE ENVÍO DE PIX
        // ---------------------------------------------------------

        if (/pix|envia el pix|envía el pix|pasame el pix|pásame el pix|quiero hacerlo|voy a pagar/i.test(texto)) {
            if (!cliente || !cliente.ultimo_monto || cliente.ultimo_monto <= 0) {
                const msg = esEspanol
                    ? "Primero indícame el monto que deseas enviar. 😊"
                    : "Primeiro informe o valor que deseja enviar. 😊";
                await enviarMensaje(phone, msg);
                return msg;
            }

            const ahora = Date.now();
            const fechaCotRef = cliente.fecha_cotizacion || cliente.updated_at;
            if (ahora - new Date(fechaCotRef).getTime() > DOS_HORAS) {
                const msgVencido = esEspanol
                    ? "La cotización anterior ha vencido. Indícame nuevamente el monto para actualizar la tasa. 📈"
                    : "A cotação anterior expirou. Informe novamente o valor para atualizar a taxa. 📈";
                await enviarMensaje(phone, msgVencido);
                return msgVencido;
            }

            const llavePix = process.env.PIX_KEY;

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
            await enviarMensaje(phone, llavePix);
            await enviarMensaje(phone, "Titular: Yordanys Rafael Sosa Reyes\n🏦 Nubank");
            await enviarMensaje(
                phone,
                esEspanol ? "Después del pago, envíe el comprobante." : "Após o pagamento, envie o comprovante."
            );

            return llavePix;
        }

        // ---------------------------------------------------------
        // 5. DETECCIÓN DE TARJETA EN IMAGEN (GPT-4o Vision)
        // ---------------------------------------------------------

        if (imageUrl && imageUrl.toLowerCase().endsWith(".pdf")) {
            console.log("📄 PDF DETECTADO:", imageUrl);
        }

        if (imageUrl && !imageUrl.toLowerCase().endsWith(".pdf")) {
            console.log("💳 Analizando imagen...");
            const respuestaGPT = await detectarTarjetaEnImagen(imageUrl);
            console.log("💳 GPT RAW:", respuestaGPT);

            let datos = {};
            try {
                const jsonLimpio = respuestaGPT
                    .replace(/```json/g, "")
                    .replace(/```/g, "")
                    .trim();
                console.log("JSON LIMPIO:", jsonLimpio);
                datos = JSON.parse(jsonLimpio);
            } catch (e) {
                console.log("❌ Error parseando JSON:", e.message);
            }

            const tarjetaLimpia = String(datos.tarjeta || "").replace(/\D/g, "");
            console.log("💳 Tarjeta:", tarjetaLimpia);
            console.log("👤 Titular:", datos.titular);
            console.log("🏦 Banco:", datos.banco);

            if (/^\d{16}$/.test(tarjetaLimpia)) {
                await guardarCliente({
                    phone,
                    tarjeta: tarjetaLimpia,
                    titular: datos.titular || "",
                    bancoDetectado: datos.banco || ""
                });
                await enviarMensaje(phone, `💳 Tarjeta detectada:\n${tarjetaLimpia}`);
                return "";
            }
            // No era tarjeta → continúa hacia comprobante
        }

        // ---------------------------------------------------------
        // 6. INTENCIÓN: COMPROBANTES
        // ---------------------------------------------------------

        console.log("DEBUG IMAGEN:", { imageUrl, estado: cliente?.estado, texto });

        const esComprobante =
            (imageUrl && cliente?.estado === "aguardando_comprovante") ||
            /paguei|pague|comprovante|comprobante|feito|realizado|ya envie|ya mande/i.test(texto);

        if (esComprobante) {
            if (!cliente || cliente.estado !== "aguardando_comprovante") {
                console.log("⚠️ Comprobante ignorado: no estaba en flujo de pago.");
                return "";
            }

            const ahora = Date.now();
            const fechaPixRef = cliente.fecha_pix || cliente.fecha_estado;
            if (ahora - new Date(fechaPixRef).getTime() > DOS_HORAS) {
                console.log("⏰ Comprobante recibido fuera del tiempo esperado.");
                await guardarCliente({
                    phone,
                    estado: "comprovante_tardio",
                    fechaEstado: new Date().toISOString()
                });
                await enviarMensaje(
                    phone,
                    "⚠️ Hemos recibido su comprobante, pero la sesión había expirado. Será revisado manualmente."
                );
                return "";
            }

            // LECTURA DEL COMPROBANTE
            if (imageUrl && imageUrl.toLowerCase().endsWith(".pdf")) {
                // ✅ NUEVO: ahora sí llama a detectarComprobantePDF
                await detectarComprobantePDF(imageUrl);
            } else if (imageUrl) {
                const datosComprobante = await detectarComprobantePIX(imageUrl);
                console.log("📄 COMPROBANTE GPT:", datosComprobante);
            }

            if (cliente.ultimo_monto > 0) {
                const operaciones = await obtenerTodas();
                const yaExistePendiente = operaciones.find(op =>
                    op.phone === phone &&
                    op.status === "pendiente" &&
                    Number(op.monto) === Number(cliente.ultimo_monto)
                );

                if (!yaExistePendiente) {
                    await agregarOperacion({
                        phone,
                        nombre: pushName || cliente.nombre || "Cliente",
                        monto: cliente.ultimo_monto,
                        tipo: cliente.tipo_favorito
                    });
                    await guardarCliente({
                        phone,
                        estado: "comprovante_recibido",
                        fechaEstado: new Date().toISOString()
                    });
                }
            }

            const respuesta = esEspanol
                ? "Perfecto 😊\nRecibimos tu comprobante. Procesaremos tu envío enseguida."
                : "Perfeito 😊\nRecebemos seu comprovante. Processaremos seu envio imediatamente.";
            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // ---------------------------------------------------------
        // 7. CÁLCULO USD -> CUP
        // ---------------------------------------------------------

        if (esMontoValido && (texto.includes("usd") || texto.includes("dolar") || texto.includes("dolares")) && !texto.includes("real") && !texto.includes("brl")) {
            const tipoUsd = texto.includes("prepago") ? "usd_prepago" : "usd_clasica";
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
                const respuesta = `💵 ${valor} USD hoy rinden ${formatearNumero(resultado.cup)} CUP 🇨🇺\n\n¿Deseas continuar?`;
                await enviarMensaje(phone, respuesta);
                return respuesta;
            }
        }

        // ---------------------------------------------------------
        // 8. CÁLCULO BRL -> CUP
        // ---------------------------------------------------------

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
                await enviarMensaje(phone, respuesta);
                return respuesta;
            }
        }

        if (valor && !esMontoValido) return "";

        // ---------------------------------------------------------
        // 9. IA COMO RESPALDO
        // ---------------------------------------------------------

        const activarIA = gatilhos.some(g => texto.includes(normalizarTexto(g)));
        if (!activarIA) return "";

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Eres YordaBot. Si el cliente quiere hablar con un humano o asesor, confirma que Yordanys lo atenderá." },
                { role: "user", content: text }
            ],
            temperature: 0.3,
            max_tokens: 100
        });

        const respuestaIA = completion?.choices?.[0]?.message?.content?.trim();
        if (respuestaIA) {
            await enviarMensaje(phone, respuestaIA);
            return respuestaIA;
        }

    } catch (error) {
        console.error("❌ Error en procesarMensaje:", error.message);
        return "";
    }
}

module.exports = { detectarTarjetaEnImagen, detectarComprobantePIX, detectarComprobantePDF, procesarMensaje }; // ✅ detectarComprobantePDF exportada
