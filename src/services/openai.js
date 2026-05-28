const axios = require("axios");
const redis = require("./redis");
const logger = require("../utils/logger");
const { calcularOperacion } = require("../engines/pricing-engine");
const { guardarCliente, obtenerCliente } = require("./customer-memory");
const { OPENAI_API_KEY, OPENAI_ASSISTANT_ID } = require("../config/env");
const { enviarMensaje } = require("./zapi");

// MEMORIA VOLÁTIL
const threads = new Map();
const usuariosProcesando = new Set();

// =====================
// DETECTAR TIPO DE OPERACIÓN
// =====================
function detectarTipoOperacion(text) {
  const lower = text.toLowerCase();
  
  if (lower.includes("usd") || lower.includes("dolar") || lower.includes("dólar")) {
    return lower.includes("prepago") ? "usd_prepago" : "usd_clasica";
  }
  if (lower.includes("saldo") || lower.includes("recarga")) return "saldo_cup";
  if (lower.includes("habana") || lower.includes("efectivo")) return "efectivo_habana";
  
  return "brl_cup"; // Por defecto
}

// =====================
// DETECTAR MUNICIPIO (Para efectivo)
// =====================
function detectarMunicipio(text) {
  const municipios = ["habana vieja", "centro habana", "plaza", "cerro", "boyeros", "guanabacoa"];
  const lower = text.toLowerCase();
  return municipios.find(m => lower.includes(m)) || null;
}

// =====================
// PROCESAR MENSAJE
// =====================
async function procesarMensaje(phone, textMessage) {
  // BLOQUEO DE CONCURRENCIA (Evita que el bot responda dos veces al mismo tiempo)
  if (usuariosProcesando.has(phone)) {
    logger("info", "USER_BUSY", { phone });
    return;
  }

  usuariosProcesando.add(phone);

  try {
    const headers = {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    };

    // 1. EXTRAER MONTO (Mejorado: evita números de teléfono o fechas cortas)
    // Busca números de 2 a 5 cifras que suelan representar dinero
    const regexValor = textMessage.match(/\b\d{2,5}\b/);
    let contextoComercial = "";

    if (regexValor) {
      const valorOperacion = Number(regexValor[0]);
      const tipoOperacion = detectarTipoOperacion(textMessage);
      const municipio = detectarMunicipio(textMessage);

      const resultado = calcularOperacion({
        tipo: tipoOperacion,
        valor: valorOperacion,
        municipio
      });

      if (resultado) {
        // Guardar en base de datos local/memoria
        guardarCliente({ phone, monto: valorOperacion, tipo: tipoOperacion });

        contextoComercial = `
--- DATOS DE COTIZACIÓN ACTUAL ---
El sistema ha calculado estos valores automáticamente:
- Cliente envía: R$${resultado.valor}
- Tasa aplicada: ${resultado.tasa}
- Cliente recibe: ${resultado.cup} CUP
${resultado.upsell ? `\n¡OFERTA UPSELL!: Si añade R$${resultado.upsell.falta}, recibiría un total de ${resultado.upsell.nuevoTotal} CUP.` : ""}
----------------------------------
`;
      }
    }

    // 2. RECUPERAR HISTORIAL/MEMORIA DEL CLIENTE
    const cliente = obtenerCliente(phone);
    if (cliente && cliente.totalOperaciones > 0) {
      contextoComercial += `
--- HISTORIAL DEL CLIENTE ---
- Operaciones totales: ${cliente.totalOperaciones}
- Total enviado históricamente: R$${cliente.totalEnviado}
- Último monto: R$${cliente.ultimoMonto}
-----------------------------
`;
    }

    // 3. GESTIÓN DE THREAD (Redis + Local Map)
    let threadId = threads.get(phone);
    if (!threadId && redis) {
      threadId = await redis.get(`thread:${phone}`);
      if (threadId) threads.set(phone, threadId);
    }

    if (!threadId) {
      const thread = await axios.post("https://api.openai.com/v1/threads", {}, { headers, timeout: 10000 });
      threadId = thread.data.id;
      threads.set(phone, threadId);
      if (redis) await redis.set(`thread:${phone}`, threadId, "EX", 60 * 60 * 24 * 7); // Expira en 7 días
    }

    // 4. ENVIAR MENSAJE A OPENAI
    await axios.post(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      role: "user",
      content: `${contextoComercial}\n\nMensaje del cliente: ${textMessage}`
    }, { headers, timeout: 10000 });

    // 5. EJECUTAR ASSISTANT
    const run = await axios.post(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      assistant_id: OPENAI_ASSISTANT_ID
    }, { headers, timeout: 10000 });

    const runId = run.data.id;

    // 6. POLLING OPTIMIZADO
    let completed = false;
    const maxTime = Date.now() + 40000; // 40 segundos máximo

    while (Date.now() < maxTime) {
      const check = await axios.get(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, { headers, timeout: 10000 });
      const status = check.data.status;

      if (status === "completed") {
        completed = true;
        break;
      } else if (["failed", "cancelled", "expired"].includes(status)) {
        throw new Error(`OpenAI Run Status: ${status}`);
      }

      await new Promise(r => setTimeout(r, 2000)); // Esperar 2 segundos entre chequeos
    }

    if (!completed) throw new Error("TIMEOUT_OPENAI_RUN");

    // 7. OBTENER RESPUESTA FINAL
    const messagesList = await axios.get(`https://api.openai.com/v1/threads/${threadId}/messages?limit=1`, { headers, timeout: 10000 });
    
    const respuestaOriginal = messagesList.data.data[0]?.content?.[0]?.text?.value;

    if (respuestaOriginal) {
        // Limpiar posibles anotaciones de OpenAI tipo 【4:0†source】
        const respuestaLimpia = respuestaOriginal.replace(/【.*?】/g, "").trim();
        
        await enviarMensaje(phone, respuestaLimpia);
        logger("info", "MESSAGE_SENT", { phone });
    }

  } catch (e) {
    logger("error", "OPENAI_ERROR", { phone, err: e.message });
    // Opcional: enviar un mensaje de error al usuario si OpenAI falla
    // await enviarMensaje(phone, "Lo siento, estoy teniendo problemas técnicos. Por favor, intenta de nuevo en unos segundos.");
  } finally {
    usuariosProcesando.delete(phone);
  }
}

module.exports = { procesarMensaje };
