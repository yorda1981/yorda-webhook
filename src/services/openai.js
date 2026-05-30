require("dotenv").config();
const OpenAI = require("openai");

const { enviarMensaje } = require("./zapi");
const { calcularOperacion } = require("./calculator");
const { guardarCliente, obtenerCliente } = require("./customer-memory");

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const gatilhos = [
    "real", "reales", "envio", "cambio", "cambiar", "taxa", "tasa", 
    "cotizacion", "precio", "valor", "cuanto", "cup", "usd", "mlc", 
    "pix", "remesa", "transferencia", "enviar", "mandar", "tarjeta", 
    "recarga", "saldo", "cubanos", "nauta", "clasica", "prepago", 
    "yordanys", "asesor", "humano", "paguei", "comprovante", "comprobante"
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

        // 1. DETECCIÓN DE IDIOMA
        const esEspanol = /hola|buenas|buenos dias|buen dia|quiero|cuanto|enviar|mandar|giro|transferencia|dinero|cuba|pesos|cup|reales|usd|dolares/i.test(texto);

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
        }

        // 3. BLINDAJE PRIORITARIO: ATENCIÓN HUMANA
        if (/yordanys|humano|asesor|tengo cup|tengo dinero en cuba|dinero en cuba|enviar para brasil|enviar desde cuba|vender cup|pesos cubanos|cambiar cup|cup por reales/i.test(texto)) {
            const respuesta = "Perfecto 😊\nYordanys te atenderá enseguida para ayudarte con esa operación. 👌";
            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // 4. LÓGICA DE ENVÍO DE PIX
        if (/pix|envia el pix|envía el pix|pasame el pix|pásame el pix|quiero hacerlo|voy a pagar|deseo continuar/i.test(texto)) {
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

        const numeroDetectado = texto.match(/\d+/);
        const valor = numeroDetectado ? Number(numeroDetectado[0]) : null;

        // 6. ACTUALIZACIÓN POR MONTO SUELTO (Ej: Cliente escribe solo "300")
        if (valor && !texto.includes("usd") && !texto.includes("cup") && cliente) {
            const resultado = calcularOperacion({ tipo: "brl_cup", valor });
            if (resultado) {
                guardarCliente({ phone, nombre: pushName, monto: valor, tipo: "brl_cup" });
                const respuesta = `💵 R$${valor} hoy serían ${formatearNumero(resultado.cup)} CUP 🇨🇺\n\n✅ Transferencia rápida\n✅ Comprobante después del envío\n\n¿Deseas realizar la operación ahora?`;
                await enviarMensaje(phone, respuesta);
                return respuesta;
            }
        }

        // 7. CONSULTA DEL ÚLTIMO MONTO (Contexto por palabras)
        if (/seria cuanto cup|seria cuantos cup|cuanto cup|cuantos cup|cuanto recibe|cuanto seria|cuanto da/i.test(texto)) {
            if (cliente && cliente.ultimoMonto > 0) {
                const resultado = calcularOperacion({ tipo: cliente.tipoFavorito || "brl_cup", valor: cliente.ultimoMonto });
                if (resultado) {
                    const respuesta = esEspanol
                        ? `💵 R$${cliente.ultimoMonto} hoy serían ${formatearNumero(resultado.cup)} CUP 🇨🇺\n\n✅ Transferencia rápida\n✅ Comprobante después del envío\n\n¿Deseas realizar la operación ahora?`
                        : `💵 R$${cliente.ultimoMonto} hoje seriam ${formatearNumero(resultado.cup)} CUP 🇨🇺\n\n✅ Transferência rápida\n✅ Comprovante após envio\n\nDeseja realizar o envio agora?`;
                    await enviarMensaje(phone, respuesta);
                    return respuesta;
                }
            }
        }

        // 8. PRIORIDAD USD -> CUP
        if (valor && texto.includes("usd")) {
            const tipoUsd = texto.includes("prepago") ? "usd_prepago" : "usd_clasica";
            const resultado = calcularOperacion({ tipo: tipoUsd, valor });
            if (resultado) {
                guardarCliente({ phone, nombre: pushName, monto: valor, tipo: tipoUsd });
                const respuesta = esEspanol
                    ? `${saludoCliente}La USD hoy está en ${resultado.tasa} CUP 🇨🇺\n\nCon ${valor} USD llegan ${formatearNumero(resultado.cup)} CUP 👍`
                    : `${saludoCliente}A USD hoje está em ${resultado.tasa} CUP 🇨🇺\n\nCom ${valor} USD chegam ${formatearNumero(resultado.cup)} CUP 👍`;
                await enviarMensaje(phone, respuesta);
                return respuesta;
            }
        }

        // 9. BRL → CUP (Detección estándar)
        if (valor && !texto.includes("usd") && (texto.includes("real") || texto.includes("reales") || texto.includes("brl") || /^\d+\s*(real|reales|brl)$/i.test(texto))) {
            const resultado = calcularOperacion({ tipo: "brl_cup", valor });
            if (resultado) {
                guardarCliente({ phone, nombre: pushName, monto: valor, tipo: "brl_cup" });
                const respuesta = `💵 R$${valor} hoy serían ${formatearNumero(resultado.cup)} CUP 🇨🇺\n\n✅ Transferencia rápida\n✅ Comprobante después del envío\n\n¿Deseas realizar la operación ahora?`;
                await enviarMensaje(phone, respuesta);
                return respuesta;
            }
        }

        // 10. REFUERZO DE ÚLTIMO MONTO (Mensajes sin número pero con "cup")
        if (texto.includes("cup") && cliente && cliente.ultimoMonto > 0 && !valor) {
            const resultado = calcularOperacion({ tipo: "brl_cup", valor: cliente.ultimoMonto });
            const respuesta = `💵 R$${cliente.ultimoMonto} hoy serían ${formatearNumero(resultado.cup)} CUP 🇨🇺\n\n✅ Transferencia rápida\n✅ Comprobante después del envío\n\n¿Deseas realizar la operación ahora?`;
            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // 11. CONSULTA GENERAL
        if (/cambio|tasa|cotizacion/i.test(texto)) {
            const respuesta = esEspanol
                ? "Hoy estamos trabajando con muy buena tasa 👍\n\n¿Deseas calcular reales o USD?"
                : "Hoje estamos trabalhando com uma taxa excelente 👍\n\nVocê deseja calcular reais ou USD?";
            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // 12. OPENAI FALLBACK
        const activarIA = gatilhos.some(g => texto.includes(normalizarTexto(g)));
        if (!activarIA) return "";

        console.log("⚠️ FALLBACK OPENAI:", texto);
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Eres YordaBot. Responde corto y profesional." },
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

module.exports = {
    procesarMensaje
};
