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
// GATILHOS (Palabras clave para IA)
// ==========================================
const gatilhos = [
    "real", "reales", "envio", "cambio", "cambiar", "taxa", "tasa", 
    "cotizacion", "precio", "valor", "cuanto", "cup", "usd", "mlc", 
    "pix", "remesa", "transferencia", "enviar", "mandar", "tarjeta", 
    "recarga", "saldo", "cubanos", "nauta", "clasica", "prepago", 
    "yordanys", "asesor", "humano", "paguei", "comprovante", "comprobante"
];

// ==========================================
// NORMALIZAR (Sin acentos para el Regex)
// ==========================================
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
// PROCESAR MENSAJE
// ==========================================
async function procesarMensaje(phone, text, pushName = "") {
    try {
        if (!text || !phone) return "";
        const texto = normalizarTexto(text);

        // 1. DETECCIÓN DE IDIOMA
        const esEspanol = /hola|buenas|buenos dias|buen dia|quiero|cuanto|enviar|mandar|giro|transferencia|dinero|cuba|pesos|cup|reales/i.test(texto);

        // 2. MEMORIA DE CLIENTE & SALUDOS BILINGÜES
        const cliente = obtenerCliente(phone);
        let saludoCliente = "";
        let vipExtra = "";

        if (cliente && cliente.vip) {
            saludoCliente = esEspanol
                ? `🔥 Cliente VIP 🔥\nHola nuevamente ${cliente.nombre || ""} 👋\n\n`
                : `🔥 Cliente VIP 🔥\nOlá novamente ${cliente.nombre || ""} 👋\n\n`;
            
            vipExtra = esEspanol
                ? "\n🔥 Atención prioritaria para clientes VIP"
                : "\n🔥 Atendimento prioritário para clientes VIP";
        } else if (cliente && cliente.totalOperaciones >= 3) {
            saludoCliente = esEspanol
                ? `Hola nuevamente ${cliente.nombre || ""} 👋\n\n`
                : `Olá novamente ${cliente.nombre || ""} 👋\n\n`;
        }

        // 3. BLINDAJE PRIORITARIO: ATENCIÓN HUMANA (Cuba -> Brasil)
        // Regla de oro: Se activa antes que el PIX para evitar errores de tasa.
        if (/yordanys|humano|asesor|tengo cup|dinero en cuba|enviar para brasil|vender cup|pesos cubanos|cambiar cup|cup por reales/i.test(texto)) {
            const respuesta = "Perfecto 😊\nYordanys te atenderá enseguida para ayudarte con esa operación. 👌";
            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // 4. LÓGICA DE ENVÍO DE PIX (Confirmación de alta intención)
        if (/quiero hacerlo|voy a pagar|pasame el pix|pásame el pix|deseo continuar|quero fazer|vou pagar|passa o pix/i.test(texto)) {
            const llavePix = "8becaaf5-f296-4cbc-a115-46e3d23b042a";
            await enviarMensaje(phone, llavePix);
            return llavePix;
        }

        // 5. INTENCIÓN: VOU FAZER / YA PAGUÉ 
        if (/vou fazer agora|voy a hacer ahora|vou transferir|voy a transferir/i.test(texto)) {
            const respuesta = esEspanol 
                ? "Perfecto 👍\n\nCuando tengas el comprobante envíalo por aquí."
                : "Perfeito 👍\n\nQuando tiver o comprovante envie por aqui.";
            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        if (/paguei|pague|comprovante|comprobante|feito|realizado/i.test(texto)) {
            const respuesta = esEspanol
                ? "Perfecto 😊\nRecibimos tu comprobante. Vamos a verificar el pago y procesaremos tu envío."
                : "Perfeito 😊\nRecebemos seu comprovante. Vamos verificar o pagamento e processaremos seu envio.";
            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // 6. FILTRO DE GATILLOS & DETECTAR MONTO
        const activarIA = gatilhos.some(g => texto.includes(normalizarTexto(g)));
        if (!activarIA) return "";

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

        // 8. USD BILINGÜE
        if (valor && texto.includes("usd")) {
            const tipoUsd = texto.includes("prepago") ? "usd_prepago" : "usd_clasica";
            const nombreUsd = tipoUsd === "usd_prepago" ? "USD Prepago" : "USD Clásica";
            const resultado = calcularOperacion({ tipo: tipoUsd, valor });

            if (resultado) {
                guardarCliente({ phone, nombre: pushName, monto: valor, tipo: tipoUsd });
                const respuesta = esEspanol
                    ? `${saludoCliente}La ${nombreUsd} hoy está en ${resultado.tasa} CUP 🇨🇺\n\nCon ${valor} USD llegan ${formatearNumero(resultado.cup)} CUP 👍`
                    : `${saludoCliente}A ${nombreUsd} hoje está em ${resultado.tasa} CUP 🇨🇺\n\nCom ${valor} USD chegam ${formatearNumero(resultado.cup)} CUP 👍`;
                await enviarMensaje(phone, respuesta);
                return respuesta;
            }
        }

        // 9. CONSULTA GENERAL
        if (/cambio|tasa|cotizacion/i.test(texto)) {
            const respuesta = esEspanol
                ? "Hoy estamos trabajando con muy buena tasa 👍\n\n¿Deseas calcular reales, USD clásica o USD prepago?"
                : "Hoje estamos trabalhando com uma taxa excelente 👍\n\nVocê deseja calcular reais, USD clássica ou USD pré-paga?";
            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // 10. OPENAI FALLBACK
        const systemPrompt = `Eres YordaBot. Responde corto y humano. Cliente: ${pushName}. VIP: ${cliente?.vip ? 'SI' : 'NO'}.`;
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
            temperature: 0.5,
            max_tokens: 120
        });
        const respuestaIA = completion?.choices?.[0]?.message?.content?.trim();
        if (respuestaIA) {
            await enviarMensaje(phone, respuestaIA);
            return respuestaIA;
        }

    } catch (error) {
        console.error("❌ Error:", error.message);
        return "";
    }
}

module.exports = { procesarMensaje };
