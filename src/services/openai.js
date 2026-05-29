require("dotenv").config();
const OpenAI = require("openai");

const { enviarMensaje } = require("./zapi");
const { calcularOperacion } = require("./calculator");
const { guardarCliente, obtenerCliente } = require("./customer-memory");

// ==========================================
// OPENAI CLIENT
// ==========================================
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ==========================================
// GATILHOS (Palabras clave para activar IA)
// ==========================================
const gatilhos = [
    "real", "reales", "envio", "cambio", "cambiar", "taxa", "tasa", 
    "cotizacion", "precio", "valor", "cuanto", "cup", "usd", "mlc", 
    "pix", "remesa", "transferencia", "enviar", "mandar", "tarjeta", 
    "recarga", "saldo", "cubanos", "nauta", "clasica", "prepago", 
    "yordanys", "asesor", "humano", "paguei", "comprovante", "comprobante"
];

// ==========================================
// NORMALIZAR (Quita acentos y pasa a minúsculas)
// ==========================================
function normalizarTexto(texto) {
    return String(texto || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

// ==========================================
// FORMATEAR NÚMERO
// ==========================================
function formatearNumero(numero) {
    return Number(numero).toLocaleString("es-ES");
}

// ==========================================
// PROCESAR MENSAJE
// ==========================================
async function procesarMensaje(phone, text, pushName = "") {
    try {
        console.log(`🧠 Procesando mensaje para ${phone}: ${text}`);

        if (!text || !phone) return "";

        const texto = normalizarTexto(text);

        // 1. MEMORIA DE CLIENTE & SALUDOS DINÁMICOS
        const cliente = obtenerCliente(phone);
        let saludoCliente = "";
        let vipExtra = "";

        if (cliente && cliente.vip) {
            saludoCliente = `🔥 Cliente VIP 🔥\nOlá novamente ${cliente.nombre || ""} 👋\n\n`;
            vipExtra = "\n🔥 Atendimento prioritário para clientes VIP";
        } else if (cliente && cliente.totalOperaciones >= 3) {
            saludoCliente = `Olá novamente ${cliente.nombre || ""} 👋\n\n`;
        }

        // 2. DETECCIÓN DE IDIOMA (Regex optimizado para texto normalizado)
        const esEspanol = /hola|buenas|buenos dias|buen dia|quiero|cuanto|enviar|mandar|giro|transferencia|dinero|cuba|pesos|cup|reales/i.test(texto);

        // 3. INTENCIÓN: VOU FAZER / VOY A HACER
        if (texto.includes("vou fazer agora") || texto.includes("voy a hacer ahora") || texto.includes("vou transferir") || texto.includes("voy a transferir")) {
            const respuesta = esEspanol 
                ? "Perfecto 👍\n\nCuando tengas el comprobante puedes enviarlo por aquí y seguimos el proceso."
                : "Perfeito 👍\n\nQuando tiver o comprovante pode enviar por aqui e seguimos o processo.";

            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // 4. INTENCIÓN: YA PAGUÉ / COMPROBANTE
        if (/paguei|pague|transferi|comprovante|comprobante|feito|realizado/i.test(texto)) {
            const respuesta = esEspanol
                ? "Perfecto 😊\n\nRecibimos tu comprobante. Vamos a verificar el pago y, una vez confirmado, procesaremos tu envío."
                : "Perfeito 😊\n\nRecebemos seu comprovante. Vamos verificar o pagamento e, assim que confirmado, processaremos seu envio.";

            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // 5. FILTRO DE GATILLOS PARA IA
        const activarIA = gatilhos.some(g => texto.includes(normalizarTexto(g)));
        if (!activarIA) return "";

        // 6. DETECTAR MONTO
        const numeroDetectado = texto.match(/\d+/);
        const valor = numeroDetectado ? Number(numeroDetectado[0]) : null;

        // 7. OPERACIÓN: BRL → CUP
        if (valor && (texto.includes("real") || texto.includes("reales") || texto.includes("brl"))) {
            const resultado = calcularOperacion({ tipo: "brl_cup", valor });

            if (resultado) {
                guardarCliente({ phone, nombre: pushName, monto: valor, tipo: "brl_cup" });

                const respuesta = esEspanol
                    ? `${saludoCliente}💵 R$${valor} hoy rinden ${formatearNumero(resultado.cup)} CUP 🇨🇺\n\n✅ Transferencia rápida\n✅ Comprobante después del envío${vipExtra}\n\n¿Deseas realizar la operación ahora?`
                    : `${saludoCliente}💵 R$${valor} hoje rendem ${formatearNumero(resultado.cup)} CUP 🇨🇺\n\n✅ Transferência rápida\n✅ Comprovante após envio${vipExtra}\n\nDeseja realizar o envio agora?`;

                await enviarMensaje(phone, respuesta);
                return respuesta;
            }
        }

        // 8. USD CLÁSICA Y PREPAGO
        if (valor && texto.includes("usd")) {
            const tipoUsd = texto.includes("prepago") ? "usd_prepago" : "usd_clasica";
            const nombreUsd = tipoUsd === "usd_prepago" ? "USD Prepago" : "USD Clásica";
            
            const resultado = calcularOperacion({ tipo: tipoUsd, valor });

            if (resultado) {
                guardarCliente({ phone, nombre: pushName, monto: valor, tipo: tipoUsd });

                const respuesta = `${saludoCliente}La ${nombreUsd} hoy está en ${resultado.tasa} CUP 🇨🇺\n\nCon ${valor} USD llegan ${formatearNumero(resultado.cup)} CUP 👍`;

                await enviarMensaje(phone, respuesta);
                return respuesta;
            }
        }

        // 9. ATENCIÓN HUMANA / OPERACIÓN CUBA -> BRASIL
        if (/yordanys|humano|asesor|tengo cup|dinero en cuba|enviar para brasil|vender cup|pesos cubanos/i.test(texto)) {
            const respuesta = "Perfecto 😊\n\nYordanys te atenderá enseguida para ayudarte con esa operación.\nPor favor aguarda un momento. 👌";
            
            // Aquí podrías marcar el status como 'humano' en tu DB si lo deseas
            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // 10. CONSULTA GENERAL DE TASAS
        if (/cambio|tasa|cotizacion/i.test(texto)) {
            const respuesta = esEspanol
                ? "Hoy estamos trabajando con muy buena tasa 👍\n\n¿Deseas calcular reales, USD clásica o USD prepago?"
                : "Hoje estamos trabalhando com uma taxa excelente 👍\n\nVocê deseja calcular reais, USD clássica ou USD pré-paga?";

            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // 11. OPENAI FALLBACK (Para dudas generales)
        const systemPrompt = `Eres YordaBot, asistente de remesas Brasil-Cuba. Eres humano, directo y vendes. Responde corto. Cliente: ${pushName}. VIP: ${cliente?.vip ? 'SI' : 'NO'}.`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: text }
            ],
            temperature: 0.5,
            max_tokens: 120
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
