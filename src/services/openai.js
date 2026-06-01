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
// DETECCIÓN DE COMPROBANTE PDF (V1 - Solo logs)
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
// HELPER: envío seguro (nunca envía undefined)
// ==========================================

async function enviarSeguro(phone, mensaje) {
    if (!mensaje) {
        console.warn("⚠️ ENVÍO BLOQUEADO — mensaje undefined o vacío");
        return;
    }
    console.log("📤 ENVIANDO:", mensaje);
    await enviarMensaje(phone, mensaje);
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
            await enviarSeguro(phone, respuesta);
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
        // 4a. CLIENTE NO PUEDE ESCANEAR EL QR ✅ NUEVO
        // ---------------------------------------------------------

        if (/no consigo escanear|nao consigo escanear|no puedo escanear|no funciona el qr|qr no funciona|escanear/i.test(texto)) {
            const llaveFallback = process.env.PIX_KEY || "8becaaf5-f296-4cbc-a115-46e3d23b042a";
            const msg = `No hay problema 😊\n\nTambién puede copiar y pegar la clave PIX:\n\n${llaveFallback}\n\nTitular: Yordanys Rafael Sosa Reyes\n🏦 Nubank`;
            await enviarSeguro(phone, msg);
            return msg;
        }

        // ---------------------------------------------------------
        // 4. LÓGICA DE ENVÍO DE PIX
        // ---------------------------------------------------------

        if (/pix|envia el pix|envía el pix|pasame el pix|pásame el pix|quiero hacerlo|voy a pagar/i.test(texto)) {
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
                const msgVenc
