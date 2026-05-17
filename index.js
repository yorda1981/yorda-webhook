const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// El puerto debe ser dinámico para Railway
const PORT = process.env.PORT || 8080;

/* =========================
   VARIABLES DE ENTORNO
========================= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ZAPI_INSTANCE = String(process.env.ZAPI_INSTANCE || "").trim();
const ZAPI_TOKEN = String(process.env.ZAPI_TOKEN || "").trim();
const ZAPI_CLIENT_TOKEN = String(process.env.ZAPI_CLIENT_TOKEN || "").trim();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/* =========================
   MEMORIA RAM (ESTADOS)
========================= */
const pausaHumana = {};
const conversaAtiva = {};
const estadoCliente = {};

const PAUSA_HUMANA_MS = 30 * 60 * 1000;
const CONVERSA_ATIVA_MS = 5 * 60 * 1000;

const PIX_CHAVE = "8becaaf5-f296-4cbc-a115-46e3d23b042a";
const PIX_NOME = "YORDANYS RAFAEL SOSA REYES\nNubank";

const GATILHOS = ["remesa", "envio", "enviar", "transferencia", "cambio", "tasa", "real", "brl", "cup", "pix", "mlc", "recarga", "etecsa"];
const SAUDACOES = ["hola", "oi", "ola", "buenas", "buen dia", "bom dia"];
const MUNICIPIOS = ["habana", "centro habana", "habana vieja", "cerro", "boyeros", "arroyo naranjo", "marianao"];

/* =========================
   HELPERS
========================= */
function resetEstado(phone) {
  estadoCliente[phone] = {
    operacion: null,
    etapa: "inicio",
    monto: null,
    municipio: null,
    tarjeta: null,
    numero: null,
    aguardando: null,
    pixEnviado: false
  };
}

function getEstado(phone) {
  if (!estadoCliente[phone]) resetEstado(phone);
  return estadoCliente[phone];
}

function contemPalavra(texto, palavra) {
  return new RegExp("(^|\\s)" + palavra + "(\\s|$)", "i").test(texto);
}

/* =========================
   ENVIAR WHATSAPP (Z-API)
========================= */
async function enviarMensaje(phone, texto) {
  try {
    const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;
    await axios.post(url, { phone, message: texto }, {
      headers: { "Client-Token": ZAPI_CLIENT_TOKEN, "Content-Type": "application/json" }
    });
  } catch (error) {
    console.log("ERRO ZAPI:", error.response?.data || error.message);
  }
}

/* =========================
   OPENAI (CORREGIDO)
========================= */
async function responderIA(mensagem, estado) {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini", // Nombre corregido
        messages: [
          {
            role: "system",
            content: `Eres YordaBot, asistente de remesas. Contexto: ${JSON.stringify(estado)}. 
            Reglas: Responde muy corto (máx 2 líneas), natural, evita sonar como robot.`
          },
          { role: "user", content: mensagem }
        ],
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    return response.data.choices[0].message.content || "Dime 👍";
  } catch (error) {
    console.log("ERRO OPENAI:", error.response?.data || error.message);
    return "Dime 👍";
  }
}

/* =========================
   WEBHOOK PRINCIPAL
========================= */
app.post("/webhook", async (req, res) => {
  const body = req.body;
  const phone = String(body.phone || "");
  const texto = body?.text?.message || "";

  // 1. Validaciones básicas e ignorar grupos/pings
  if (!phone || body.isGroup || body.fromMe && body.fromApi) return res.sendStatus(200);

  // 2. Pausa Humana (Si tú escribes desde el cel, el bot se calla)
  if (body.fromMe) {
    pausaHumana[phone] = Date.now() + PAUSA_HUMANA_MS;
    return res.sendStatus(200);
  }

  if (pausaHumana[phone] && Date.now() < pausaHumana[phone]) return res.sendStatus(200);

  const textoLimpo = texto.toLowerCase();

  // 3. Lógica de Negocio / Estados
  let estado = getEstado(phone);

  // Extraer datos (Lógica simplificada)
  if (textoLimpo.includes("transferencia")) estado.operacion = "transferencia";
  if (textoLimpo.includes("recarga")) estado.operacion = "recarga";

  // 4. Decidir Respuesta
  // Si es una palabra clave comercial, activamos IA o flujo
  const esComercial = GATILHOS.some(g => contemPalavra(textoLimpo, g));
  
  if (esComercial || (conversaAtiva[phone] && Date.now() < conversaAtiva[phone])) {
    conversaAtiva[phone] = Date.now() + CONVERSA_ATIVA_MS;

    // Aquí podrías insertar tu lógica de "esperando_monto", etc.
    // Por ahora, usamos la IA corregida para fluidez:
    const respuestaIA = await responderIA(texto, estado);
    await enviarMensaje(phone, respuestaIA);
  }

  res.sendStatus(200);
});

/* =========================
   HEALTH & START
========================= */
app.get("/", (req, res) => res.send("🚀 YordaBot ONLINE ✅"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Serv
