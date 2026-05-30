require("dotenv").config();
const OpenAI = require("openai");

const { enviarMensaje } = require("./zapi");
const { calcularOperacion } = require("./calculator");
const { guardarCliente, obtenerCliente } = require("./customer-memory");

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ==========================================
// GATILHOS (Solo para soporte humano)
// ==========================================
const gatilhos = [
    "yordanys", "asesor", "humano", "ayuda", "informacion", "contacto"
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

async function procesarMensaje(phone, text, pushName = "") {
    try {
        if (!text || !phone) return "";
        const texto = normalizarTexto(text);

        // 1. DETECCIÓN DE IDIOMA (Regex optimizado)
        const esEspanol = /hola|buenas|buenos dias|buen dia|quiero|cuanto|enviar|mandar|giro|transferencia|dinero|cuba|pesos|cup|reales|usd|dolares|dolar/i.test(texto);

        // 2. MEMORIA DE CLIENTE
        const cliente = obtenerCliente(phone);

        // 3. ATENCIÓN HUMANA / CASOS ESPECIALES (Arbitraje, CUP o MLC)
        // Corregido: Detección consistente de dolar/dolares/usd para arbitraje
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

        // 4. LÓGICA DE ENVÍO DE PIX
        if (/pix|envia el pix|envía el pix|pasame el pix|pásame el pix|quiero hacerlo|voy a pagar/i.test(texto)) {
            const llavePix = "8becaaf5-f296-4cbc-a115-46e3d23b042a";
            await enviarMensaje(phone, llavePix);
            return llavePix;
        }

        // 5. INTENCIÓN: COMPROBANTES
        if (/paguei|pague|comprovante|comprobante|feito|realizado|ya envie|ya mande/i.test(texto)) {
            const respuesta = esEspanol
                ? "Perfecto 😊\nRecibimos tu comprobante. Vamos a verificar el pago y procesaremos tu envío enseguida."
                : "Perfeito 😊\nRecebemos seu comprovante. Vamos verificar o pagamento e processaremos seu envio imediatamente.";
            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        const numeroDetectado = texto.match(/\d+/);
        const valor = numeroDetectado ? Number(numeroDetectado[0]) : null;

        // ---------------------------------------------------------
        // 6. CÁLCULO USD -> CUP (Detección completa de variantes)
        // ---------------------------------------------------------
        if (valor && (texto.includes("usd") || texto.includes("dolar") || texto.includes("dolares")) && !texto.includes("real") && !texto.includes("brl")) {
            const tipoUsd = texto.includes("prepago") ? "usd_prepago" : "usd_clasica";
            const nombreTarjeta = tipoUsd === "usd_prepago" ? "USD Prepago" : "USD Clásica";
            
            const resultado = calcularOperacion({ tipo: tipoUsd, valor });
            if (resultado) {
                guardarCliente({ phone, nombre: pushName, monto: valor, tipo: tipoUsd });
                const respuesta = `💵 ${valor} USD (${nombreTarjeta}) hoy rinden ${formatearNumero(resultado.cup)} CUP 🇨🇺\n\n¿Deseas continuar?`;
                await enviarMensaje(phone, respuesta);
                return respuesta;
            }
        }

        // ---------------------------------------------------------
        // 7. CÁLCULO BRL -> CUP (Monto suelto o Reales)
        // ---------------------------------------------------------
        if (
            valor && 
            !texto.includes("usd") && !texto.includes("dolar") && !texto.includes("dolares") && 
            !texto.includes("cup") && !texto.includes("mlc")
        ) {
            const resultado = calcularOperacion({ tipo: "brl_cup", valor });
            if (resultado) {
                guardarCliente({ phone, nombre: pushName, monto: valor, tipo: "brl_cup" });
                const respuesta = `💵 R$${valor} hoy serían ${formatearNumero(resultado.cup)} CUP 🇨🇺\n\n¿Deseas realizar la operación ahora?`;
                await enviarMensaje(phone, respuesta);
                return respuesta;
            }
        }

        // 8. BLOQUEO PREVENTIVO
        if (valor) {
            console.log("⚠️ Monto no reconocido, silencio preventivo:", texto);
            return ""; 
        }

        // 9. OPENAI FALLBACK (Solo soporte)
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
