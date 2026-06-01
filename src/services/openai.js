require("dotenv").config();

const OpenAI = require("openai");

const { enviarMensaje, enviarImagen } = require("./zapi");
const { calcularOperacion } = require("./calculator");
const { guardarCliente, obtenerCliente } = require("./customer-memory");
const { agregarOperacion, obtenerTodas } = require("./operations");

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ==========================================
// CONFIGURACIONES DE SEGURIDAD (V. FINAL)
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
                            text: `Extrae únicamente un número de tarjeta de 16 dígitos visible en la imagen.\n\nReglas:\n- Responde SOLO los 16 números.\n- Si no existe una tarjeta visible responde:\nNO_ENCONTRADA`
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: imageUrl
                            }
                        }
                    ]
                }
            ],
            max_tokens: 30
        });

        return response.choices?.[0]?.message?.content?.trim();

    } catch (error) {
        console.error("❌ Error detectando tarjeta:", error.message);
        return null;
    }
}

async function procesarMensaje(phone, text, pushName = "", imageUrl = null) {
    console.log("NOMBRE CLIENTE:", pushName);
    if (imageUrl) console.log("🖼️ imageUrl recibida:", imageUrl);

    try {
        if (!text || !phone) return "";

        const texto = normalizarTexto(text);

        // 1. DETECCIÓN DE IDIOMA
        const esEspanol = /hola|buenas|buenos dias|buen dia|quiero|cuanto|enviar|mandar|giro|transferencia|dinero|cuba|pesos|cup|reales|usd|dolares|dolar/i.test(texto);

        // 2. MEMORIA DE CLIENTE (Asíncrono)
        const cliente = await obtenerCliente(phone);

        // 3. ATENCIÓN HUMANA
        if (
            /yordanys|humano|asesor|tengo cup|dinero en cuba|enviar para brasil|traer para brasil|vender cup|cup por reales/i.test(texto) ||
            ((texto.includes("usd") || texto.includes("dolar") || texto.includes("dolares")) && (texto.includes("real") || texto.includes("brl") || texto.includes("brasil"))) ||
            (texto.includes("cup") && !texto.includes("real") && !texto.includes("usd") && !texto.includes("dolar") && !texto.includes("dolares")) ||
            (texto.includes("mlc"))
        ) {
            const respuesta = esEspanol
                ? "Perfecto 😊\nYordanys te atenderá enseguida para darte la cotización exacta de esa operación. 👌"
                : "Perfeito 😊\nYordanys irá atendê-lo imediatamente para lhe dar a cotação exata dessa operação. 👌";

            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // VALIDACIÓN DE NÚMEROS (Tarjetas vs Montos)
        const soloNumeros = texto.replace(/\D/g, '');
        const valor = soloNumeros.length > 0 ? Number(soloNumeros) : null;

        if (soloNumeros.length === 16) {
            console.log("💳 Tarjeta detectada, guardando silencio.");
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

            const llavePix = "8becaaf5-f296-4cbc-a115-46e3d23b042a";

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

            await enviarMensaje(phone, "8becaaf5-f296-4cbc-a115-46e3d23b042a");
            await enviarMensaje(phone, "Titular: Yordanys Rafael Sosa Reyes\n🏦 Nubank");
            await enviarMensaje(
                phone,
                esEspanol
                    ? "Después del pago, envíe el comprobante."
                    : "Após o pagamento, envie o comprovante."
            );

            return llavePix;
        }

        // ---------------------------------------------------------
        // 5. INTENCIÓN: COMPROBANTES
        // ---------------------------------------------------------
        console.log("DEBUG IMAGEN:", {
            imageUrl,
            estado: cliente?.estado,
            texto
        });

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
                console.log("⏰ Sesión de pago vencida.");
                await guardarCliente({ phone, estado: null, fechaEstado: null, fechaPix: null });
                return "";
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
                        phone: phone,
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
        // 6. DETECCIÓN DE TARJETA EN IMAGEN (GPT-4o Vision)
        // ---------------------------------------------------------
        if (imageUrl) {
            console.log("💳 Analizando imagen...");

            const tarjetaDetectada = await detectarTarjetaEnImagen(imageUrl);

            console.log("💳 Resultado GPT:", tarjetaDetectada);

            if (tarjetaDetectada && /^\d{16}$/.test(tarjetaDetectada)) {
                await guardarCliente({
                    phone,
                    tarjeta: tarjetaDetectada
                });

                await enviarMensaje(
                    phone,
                    `💳 Tarjeta detectada:\n${tarjetaDetectada}`
                );

                return "";
            }

            await enviarMensaje(
                phone,
                "⚠️ No pude detectar una tarjeta válida en la imagen."
            );

            return "";
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
        // 8. CÁLCULO BRL -> CUP (Con Mensajes de Incentivo)
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
        // 9. IA COMO RESPALDO (Solo si hay gatillo)
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

module.exports = { procesarMensaje };
