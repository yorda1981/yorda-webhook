require("dotenv").config();

const OpenAI = require("openai");

const {
    enviarMensaje
} = require("./zapi");

const {
    calcularOperacion
} = require("./calculator");

const {
    guardarCliente,
    obtenerCliente
} = require("./customer-memory");

// ==========================================
// OPENAI CLIENT
// ==========================================

const openai =
    new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });

// ==========================================
// GATILHOS
// ==========================================

const gatilhos = [
    "real",
    "reales",
    "brl",
    "cambio",
    "cambiar",
    "taxa",
    "tasa",
    "cotizacion",
    "cotización",
    "precio",
    "valor",
    "cuanto",
    "cuánto",
    "cup",
    "usd",
    "mlc",
    "pix",
    "remesa",
    "transferencia",
    "enviar",
    "mandar",
    "tarjeta",
    "recarga",
    "saldo",
    "internet",
    "nauta",
    "clasica",
    "clásica",
    "prepago",
    "yordanys",
    "asesor",
    "humano",
    "paguei",
    "ja paguei",
    "já paguei",
    "comprovante",
    "comprobante"
];

// ==========================================
// NORMALIZAR
// ==========================================

function normalizarTexto(texto) {
    return String(texto || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

// ==========================================
// FORMATEAR
// ==========================================

function formatearNumero(numero) {
    return Number(numero)
        .toLocaleString("es-ES");
}

// ==========================================
// PROCESAR MENSAJE
// ==========================================

async function procesarMensaje(
    phone,
    text,
    pushName = ""
) {
    try {
        console.log(
            `🧠 Procesando mensaje para ${phone}: ${text}`
        );

        if (!text || !phone) {
            return "";
        }

        const texto =
            normalizarTexto(text);

        // ==========================================
        // MEMORIA DE CLIENTE & SALUDOS DINÁMICOS
        // ==========================================
        const cliente =
            obtenerCliente(phone);

        let saludoCliente = "";
        let vipExtra = "";

        if (
            cliente &&
            cliente.vip
        ) {
            saludoCliente =
                `🔥 Cliente VIP 🔥\nOlá novamente ${cliente.nombre || ""} 👋\n\n`;
            vipExtra = 
                "\n🔥 Atendimento prioritário para clientes VIP";
        }
        else if (
            cliente &&
            cliente.totalOperaciones >= 3
        ) {
            saludoCliente =
                `Olá novamente ${cliente.nombre || ""} 👋\n\n`;
        }

        // ==========================================
        // DETECCIÓN DE INTENCIÓN: VOU FAZER AGORA
        // ==========================================
        if (
            texto.includes("vou fazer agora") ||
            texto.includes("voy hacer ahora") ||
            texto.includes("ya voy hacer") ||
            texto.includes("vou transferir")
        ) {
            const respuesta =
                "Perfeito 👍\n\nQuando tiver o comprovante pode enviar por aqui e seguimos o processo.";

            guardarCliente({
                phone,
                nombre: pushName
            });

            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // ==========================================
        // DETECCIÓN DE INTENCIÓN: YA TRANSFERÍ / PAGADO (CORREGIDO SIN "PAGO")
        // ==========================================
        if (
            texto.includes("ya transferi") ||
            texto.includes("ya transferí") ||
            texto.includes("ja transferi") ||
            texto.includes("comprovante") ||
            texto.includes("comprobante") ||
            texto.includes("ja paguei") ||
            texto.includes("já paguei") ||
            texto.includes("paguei") ||
            texto.includes("pagado") ||
            texto.includes("pix feito") ||
            texto.includes("pix realizado")
        ) {
            const respuesta =
                "Perfeito 👍\n\nRecebemos sua mensagem. Assim que a transferência for confirmada enviaremos o comprovante.";

            await enviarMensaje(phone, respuesta);
            return respuesta;
        }

        // ==========================================
        // ACTIVAR IA SOLO PARA MENSAJES COMERCIALES
        // ==========================================
        const activarIA =
            gatilhos.some(
                g =>
                    texto.includes(
                        normalizarTexto(g)
                    )
            );

        if (!activarIA) {
            console.log(
                "🚫 Mensaje ignorado"
            );
            return "";
        }

        // ==========================================
        // DETECTAR MONTO
        // ==========================================

        const numeroDetectado =
            texto.match(/\d+/);

        const valor =
            numeroDetectado
                ? Number(numeroDetectado[0])
                : null;

        // ==========================================
        // BRL → CUP 
        // ==========================================

        if (
            valor &&
            (
                texto.includes("real") ||
                texto.includes("reales") ||
                texto.includes("brl")
            )
        ) {
            const resultado =
                calcularOperacion({
                    tipo: "brl_cup",
                    valor
                });

            if (resultado) {
                guardarCliente({
                    phone,
                    nombre: pushName,
                    monto: valor,
                    tipo: "brl_cup"
                });

                const respuesta =
`${saludoCliente}💵 R$${valor} hoje rendem ${formatearNumero(resultado.cup)} CUP 🇨🇺

✅ Transferência rápida
✅ Comprovante após envio${vipExtra}

Deseja realizar o envio agora?`;

                await enviarMensaje(
                    phone,
                    respuesta
                );

                return respuesta;
            }
        }

        // ==========================================
        // USD CLÁSICA
        // ==========================================

        if (
            valor &&
            texto.includes("usd") &&
            (
                texto.includes("clasica") ||
                texto.includes("clásica")
            )
        ) {
            const resultado =
                calcularOperacion({
                    tipo: "usd_clasica",
                    valor
                });

            if (resultado) {
                guardarCliente({
                    phone,
                    nombre: pushName,
                    monto: valor,
                    tipo: "usd_clasica"
                });

                const respuesta =
`${saludoCliente}La USD clásica hoy está en ${resultado.tasa} CUP 🇨🇺

Con ${valor} USD clásica llegan ${formatearNumero(resultado.cup)} CUP 👍`;

                await enviarMensaje(
                    phone,
                    respuesta
                );

                return respuesta;
            }
        }

        // ==========================================
        // USD PREPAGO
        // ==========================================

        if (
            valor &&
            texto.includes("usd") &&
            texto.includes("prepago")
        ) {
            const resultado =
                calcularOperacion({
                    tipo: "usd_prepago",
                    valor
                });

            if (resultado) {
                guardarCliente({
                    phone,
                    nombre: pushName,
                    monto: valor,
                    tipo: "usd_prepago"
                });

                const respuesta =
`${saludoCliente}La USD prepago hoy está en ${resultado.tasa} CUP 🇨🇺

Con ${valor} USD prepago llegan ${formatearNumero(resultado.cup)} CUP 👍`;

                await enviarMensaje(
                    phone,
                    respuesta
                );

                return respuesta;
            }
        }

        // ==========================================
        // CONSULTA GENERAL CAMBIO
        // ==========================================

        if (
            texto.includes("cambio") ||
            texto.includes("tasa") ||
            texto.includes("cotizacion") ||
            texto.includes("cotización")
        ) {
            let respuesta =
"Hoy estamos trabajando con muy buena tasa 👍\n\n¿Deseas calcular reales, USD clásica o USD prepago?";

            if (cliente?.vip) {
                respuesta +=
"\n\n🔥 Cliente VIP detectado.";
            }

            await enviarMensaje(
                phone,
                respuesta
            );

            return respuesta;
        }

        // ==========================================
        // HABLAR CON YORDANYS
        // ==========================================

        if (
            texto.includes("yordanys") ||
            texto.includes("humano") ||
            texto.includes("asesor")
        ) {
            const respuesta =
                "Yordanys ahora mismo está ocupado 👌\n\nApenas pueda entra al chat.";

            await enviarMensaje(
                phone,
                respuesta
            );

            return respuesta;
        }

        // ==========================================
        // PROMPT EXTRA
        // ==========================================

        let contextoCliente = "";

        if (cliente) {
            contextoCliente +=
`
CLIENTE:
- Nombre: ${cliente.nombre || "No definido"}
- Total operaciones: ${cliente.totalOperaciones || 0}
- Total enviado: ${cliente.totalEnviado || 0}
- VIP: ${cliente.vip ? "SI" : "NO"}
- Tipo favorito: ${cliente.tipoFavorito || "No definido"}
`;
        }

        // ==========================================
        // OPENAI
        // ==========================================

        const systemPrompt =
`
Eres YordaBot.

${contextoCliente}

REGLAS:
- Responder siempre en español.
- Sonar humano.
- Respuestas cortas estilo WhatsApp.
- Hablar como vendedor real.
- No parecer IA.
- No inventar tasas.
- No inventar cálculos.
- No usar textos largos.
- No usar lenguaje técnico.
- No decir:
  "procesando"
  "transacción"
  "aguarde"

- Si no sabes una tasa:
  pedir el monto.

- Si el cliente es VIP:
  tratar con prioridad.
`;

        const completion =
            await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: systemPrompt
                    },
                    {
                        role: "user",
                        content: text
                    }
                ],
                temperature: 0.5,
                max_tokens: 120
            });

        const respuesta =
            completion
                ?.choices?.[0]
                ?.message?.content
                ?.trim();

        if (!respuesta) {
            console.log(
                "❌ OpenAI vacío"
            );
            return "";
        }

        // ==========================================
        // ENVIAR
        // ==========================================

        await enviarMensaje(
            phone,
            respuesta
        );

        console.log(
            `✅ Mensaje enviado a ${phone}`
        );

        return respuesta;

    } catch (error) {
        console.error(
            "❌ Error en procesarMensaje:"
        );
        console.error(
            error.message
        );

        try {
            await enviarMensaje(
                phone,
                "Hola 👋\n\nAhora mismo estamos con muchas solicitudes. Escríbeme nuevamente en unos minutos."
            );
        } catch (e) {
            console.error(
                "❌ Error enviando fallback"
            );
        }

        return "";
    }
}

// ==========================================
// EXPORT
// ==========================================

module.exports = {
    procesarMensaje
};
