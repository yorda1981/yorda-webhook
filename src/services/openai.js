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

        // ---------------------------------------------------------
        // 3. BLINDAJE PRIORITARIO: ATENCIÓN HUMANA (Cuba -> Brasil)
        // ---------------------------------------------------------
        // Esta regla va PRIMERO para evitar que el bot mande el PIX 
        // en operaciones que requieren negociación manual.
        if (/yordanys|humano|asesor|tengo cup|dinero en cuba|enviar para brasil|vender cup|pesos cubanos|cambiar cup|cup por reales/i.test(texto)) {
            const respuesta = "Perfecto 😊\nYordanys te atenderá enseguida para ayudarte con esa operación. 👌";
            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // 4. LÓGICA DE ENVÍO DE PIX (Solo si superó el filtro humano)
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
