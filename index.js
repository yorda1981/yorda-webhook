const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

/* =========================
   VARIABLES DE ENTORNO
========================= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ZAPI_INSTANCE = String(process.env.ZAPI_INSTANCE || "").trim();
const ZAPI_TOKEN = String(process.env.ZAPI_TOKEN || "").trim();
const ZAPI_CLIENT_TOKEN = String(process.env.ZAPI_CLIENT_TOKEN || "").trim();
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

/* =========================
   CONFIGURACIÓN GOOGLE SHEETS
========================= */
let sheets;
try {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(GOOGLE_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheets = google.sheets({ version: "v4", auth });
  console.log("✅ Conexión con Google Sheets configurada");
} catch (e) {
  console.log("❌ Error en Google Sheets:", e.message);
}

async function salvarEnGoogleSheets(datos) {
  if (!sheets) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Hoja 1!A:G",
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[
          new Date().toLocaleString("es-ES", { timeZone: "America/Sao_Paulo" }),
          datos.phone,
          datos.operacion || "Consulta",
          datos.monto || "",
          datos.destino || "",
          datos.municipio || "",
          "🟠 Pendiente"
        ]],
      },
    });
  } catch (err) {
    console.log("❌ Error guardando en Sheets:", err.message);
  }
}

/* =========================
   MEMORIA RAM (ESTADOS)
========================= */
const pausaHumana = {};
const conversaAtiva = {};
const estadoCliente = {};

const PAUSA_HUMANA_MS = 30 * 60 * 1000;
const CONVERSA_ATIVA_MS = 5 * 60 * 1000;

const GATILHOS = ["remesa", "envio", "enviar", "transferencia", "cambio", "tasa", "real", "brl", "cup", "pix", "mlc", "recarga", "etecsa"];
const SAUDACOES = ["hola", "oi", "ola", "buenas", "buen dia", "bom dia"];
const MUNICIPIOS_LISTA = ["habana", "centro habana", "habana vieja", "cerro", "boyeros", "arroyo naranjo", "marianao"];

/* =========================
   HELPERS
========================= */
function getEstado(phone) {
  if (!estadoCliente[phone]) {
    estadoCliente[phone] = { operacion: null, monto: null, destino: null, municipio: null };
  }
  return estadoCliente[phone];
}

function contemPalavra(texto, palabra) {
  if (!texto || !palabra) return false;
  const palabraEscapada = palabra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp("(^|\\s)" + palabraEscapada + "(\\s|$)", "i").test(texto);
}

/* =========================
   APIS EXTERNAS
========================= */
async function enviarMensaje(phone, texto) {
  try {
    const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;
    await axios.post(url, { phone, message: texto }, {
      headers: { "Client-Token": ZAPI_CLIENT_TOKEN, "Content-Type": "application/json" }
    });
  } catch (error) {
    console.log("❌ Error Z-API:", error.message);
  }
}

async function responderIA(mensagem, estado) {
  try {
    const response = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Eres YordaBot, asistente de remesas. Contexto: ${JSON.stringify(estado)}. Responde muy corto (máx 2 líneas).` },
        { role: "user", content: mensagem }
      ]
    }, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }
    });
    return response.data.choices[0].message.content;
  } catch (error) {
    return "Dime 👍";
  }
}

/* =========================
   WEBHOOK
========================= */
app.post("/webhook", async (req, res) => {
  const body = req.body;
  const phone = String(body.phone || "");
  const texto = body?.text?.message || "";

  if (!phone || body.isGroup || (body.fromMe && body.fromApi)) return res.sendStatus(200);

  if (body.fromMe) {
    pausaHumana[phone] = Date.now() + PAUSA_HUMANA_MS;
    return res.sendStatus(200);
  }

  if (pausaHumana[phone] && Date.now() < pausaHumana[phone]) return res.sendStatus(200);

  const textoLimpo = texto.toLowerCase();
  let estado = getEstado(phone);

  // EXTRAER DATOS AUTOMÁTICAMENTE
  // Buscar montos (números de 1 a 5 dígitos)
  const matchMonto = texto.match(/\b\d{1,5}\b/);
  if (matchMonto && !estado.monto) estado.monto = matchMonto[0];

  // Buscar Tarjetas (16 dígitos) o Celulares (8-10 dígitos)
  const numeros = texto.replace(/\D/g, "");
  if (numeros.length === 16) estado.destino = numeros;
  else if (numeros.length >= 8 && numeros.length <= 11) estado.destino = numeros;

  // Buscar Municipio
  for (const m of MUNICIPIOS_LISTA) {
    if (textoLimpo.includes(m)) estado.municipio = m;
  }

  const esComercial = GATILHOS.some(g => contemPalavra(textoLimpo, g));
  const esSaudacao = SAUDACOES.some(s => contemPalavra(textoLimpo, s));

  if (esComercial || esSaudacao || (conversaAtiva[phone] && Date.now() < conversaAtiva[phone])) {
    conversaAtiva[phone] = Date.now() + CONVERSA_ATIVA_MS;
    
    if (textoLimpo.includes("remesa")) estado.operacion = "remesa";
    if (textoLimpo.includes("recarga")) estado.operacion = "recarga";

    const respuesta = await responderIA(texto, estado);
    await enviarMensaje(phone, respuesta);

    // GUARDAR EN GOOGLE SHEETS DE FORMA ORGANIZADA
    await salvarEnGoogleSheets({
      phone,
      operacion: estado.operacion,
      monto: estado.monto,
      destino: estado.destino,
      municipio: estado.municipio
    });
  }

  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("🚀 YordaBot CRM Online ✅"));

app.listen(PORT, "0.0.0.0", () => console.log(`Servidor en puerto ${PORT}`));
