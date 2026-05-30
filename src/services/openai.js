require("dotenv").config();
const OpenAI = require("openai");

const { enviarMensaje } = require("./zapi");
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

async function procesarMensaje(phone, text, pushName = "") {
    try {
        if (!text || !phone) return "";
        const texto = normalizarTexto(text);

        // 1. DETECCIÓN DE IDIOMA
        const esEspanol = /hola|buenas|buenos dias|buen dia|quiero|cuanto|enviar|mandar|giro|transferencia|dinero|cuba|pesos|cup|reales|usd|dolares|dolar/i.test(texto);

        // 2. MEMORIA DE CLIENTE
        const cliente = obtenerCliente(phone);

        // 3. ATENCIÓN HUMANA / CASOS ESPECIALES
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

        // ---------------------------------------------------------
        // VALIDACIÓN DE NÚMEROS (Tarjetas vs Montos)
        // ---------------------------------------------------------
        const soloNumeros = texto.replace(/\D/g, '');
        const valor = soloNumeros.length > 0 ? Number(soloNumeros) : null;

        // PRIORIDAD 1: Si tiene 16 dígitos, es una tarjeta. No cotizar.
        if (soloNumeros.length === 16) {
            console.log("💳 Tarjeta detectada, guardando y guardando silencio.");
            guardarCliente({ phone, tarjeta: soloNumeros });
            return ""; 
        }

        // PRIORIDAD 2: Rango lógico para remesas (10 a 50.000)
        const esMontoValido = valor && valor >= 10 && valor <= 50000;

        // ---------------------------------------------------------
        // 4. LÓGICA DE ENVÍO DE PIX
        // ---------------------------------------------------------
        if (/pix|envia el pix|envía el pix|pasame el pix|pásame el pix|quiero hacerlo|voy a pagar/i.test(texto)) {
            
            if (!cliente || !cliente.ultimoMonto || cliente.ultimoMonto <= 0) {
                const msg = esEspanol
                    ? "Primero indícame el monto que deseas enviar. 😊"
                    : "Primeiro informe o valor que deseja enviar. 😊";
                await enviarMensaje(phone, msg);
                return msg;
            }

            const ahora = Date.now();
            const fechaRef = cliente.fechaEstado || cliente.updatedAt;
            if (ahora - new Date(fechaRef).getTime() > DOS_HORAS) {
                const msgVencido = esEspanol
                    ? "La cotización anterior ha vencido. Indícame nuevamente el monto para actualizar la tasa. 📈"
                    : "A cotação anterior expirou. Informe novamente o valor para atualizar a taxa. 📈";
                await enviarMensaje(phone, msgVencido);
                return msgVencido;
            }

            const llavePix = "8becaaf5-f296-4cbc-a115-46e3d23b042a";
            guardarCliente({
                phone,
                estado: "aguardando_comprovante",
                fechaEstado: new Date().toISOString()
            });

            await enviarMensaje(phone, llavePix);
            return llavePix;
        }

        // ---------------------------------------------------------
        // 5. INTENCIÓN: COMPROBANTES (Con Vencimiento y Seguridad)
        // ---------------------------------------------------------
        if (/paguei|pague|comprovante|comprobante|feito|realizado|ya envie|ya mande/i.test(texto)) {
            
            if (!cliente || cliente.estado !== "aguardando_comprovante") {
                console.log(`⚠️ Comprobante ignorado de ${phone}: no estaba en flujo de pago.`);
                return ""; 
            }

            const ahora = Date.now();
            if (ahora - new Date(cliente.fechaEstado).getTime() > DOS_HORAS) {
                console.log(`⏰ Sesión de pago vencida para ${phone}.`);
                guardarCliente({ phone, estado: null, fechaEstado: null });
                return ""; 
            }

            if (cliente.ultimoMonto > 0) {
                const operaciones = obtenerTodas();
                const yaExistePendiente = operaciones.find(op => 
                    op.phone === phone && op.status === "pendiente" && op.monto === cliente.ultimoMonto
                );

                if (!yaExistePendiente) {
                    agregarOperacion({
                        phone: phone,
                        nombre: pushName || cliente.nombre || "Cliente",
                        monto: cliente.ultimoMonto,
                        tipo: cliente.tipoFavorito
                    });
                    guardarCliente({
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
        // 6. CÁLCULO USD -> CUP
        // ---------------------------------------------------------
        if (esMontoValido && (texto.includes("usd") || texto.includes("dolar") || texto.includes("dolares")) && !texto.includes("real") && !texto.includes("brl")) {
            const tipoUsd = texto.includes("prepago") ? "usd_prepago" : "usd_clasica";
            const resultado = calcularOperacion({ tipo: tipoUsd, valor });
            if (resultado) {
                guardarCliente({ 
                    phone, nombre: pushName, monto: valor, tipo: tipoUsd,
                    estado: "cotizacion_realizada", fechaEstado: new Date().toISOString()
                });
                const respuesta = `💵 ${valor} USD hoy rinden ${formatearNumero(resultado.cup)} CUP 🇨🇺\n\n¿Deseas continuar?`;
                await enviarMensaje(phone, respuesta);
                return respuesta;
            }
        }

        // ---------------------------------------------------------
        // 7. CÁLCULO BRL -> CUP
        // ---------------------------------------------------------
        if (esMontoValido && !texto.includes("usd") && !texto.includes("dolar") && !texto.includes("dolares") && !texto.includes("cup") && !texto.includes("mlc")) {
            const resultado = calcularOperacion({ tipo: "brl_cup", valor });
            if (resultado) {
                guardarCliente({ 
                    phone, nombre: pushName, monto: valor, tipo: "brl_cup",
                    estado: "cotizacion_realizada", fechaEstado: new Date().toISOString()
                });
                const respuesta = `💵 R$${valor} hoy serían ${formatearNumero(resultado.cup)} CUP 🇨🇺\n\n¿Deseas realizar la operación ahora?`;
                await enviarMensaje(phone, respuesta);
                return respuesta;
            }
        }

        // 8. BLOQUEO PREVENTIVO (Fuera de rango o sin intención)
        if (valor && !esMontoValido) return ""; 

        // 9. OPENAI FALLBACK
        const activarIA = gatilhos.some(g => texto.includes(normalizarTexto(g)));
        if (!activarIA) return "";

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Eres YordaBot. Si el cliente quiere hablar con un humano o asesor, confirma que Yordanys lo atenderá. No inventes tasas ni calcules dinero." },
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
