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
  console.log("✅ Conexión con Google Sheets lista para Dashboard");
} catch (e) {
  console.log("❌ Error en Google Sheets:", e.message);
}

async function salvarEnGoogleSheets(datos) {
  if (!sheets) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Hoja 1!A:I", 
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[
          new Date().toLocaleString("es-ES", { timeZone: "America/Sao_Paulo" }),
          datos.phone,
          datos.operacion || "Consulta",
          datos.monto || 0,
          datos.destino || "",
          datos.municipio || "",
          "🟠 Pendiente",
          datos.tasa || 115, // Tasa base
          "" // El lucro se calcula con fórmula en Excel
        ]],
      },
    });
  } catch (err) {
    console.log("❌ Error guardando datos:", err.message);
  }
}

/* =========================
   MEMORIA Y FILTROS DISCRETOS
========================= */
const pausaHumana = {};
const conversaAtiva = {};
const estadoCliente = {};
let mensajesProcesados = new Set();

const GATILHOS = ["remesa", "envio", "enviar", "transferencia", "cambio", "tasa", "real", "brl", "cup", "pix", "mlc", "recarga", "precio", "cuanto", "tarjeta"];
const MUNICIPIOS_LISTA = ["habana", "centro habana", "habana vieja", "cerro", "boyeros", "arroyo naranjo", "marianao", "playa"];

/* =========================
   APIS EXTERNAS
========================= */
async function enviarMensaje(phone, texto) {
  try {
    await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
    { phone, message: texto }, 
    { headers: { "Client-Token": ZAPI_CLIENT_TOKEN } });
  } catch (error) { console.log("❌ Error Z-API"); }
}

async function responderIA(mensagem, estado) {
  try {
    const response = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Eres YordaBot, asistente de remesas profesional. Responde en máximo 2 líneas. Sé amable pero directo." },
        { role: "user", content: `Contexto: ${JSON.stringify(estado)}. Mensaje: ${mensagem}` }
      ]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    return response.data.choices[0].message.content;
  } catch (error) { return "Dime 👍"; }
}

/* =========================
   WEBHOOK (LÓGICA DE NEGOCIO)
========================= */
app.post("/webhook", async (req, res) => {
  const body = req.body;
  const phone = String(body.phone || "");
  const texto = body?.text?.message || "";
  const msgId = body.messageId;

  if (!phone || body.isGroup || body.fromMe || mensajesProcesados.has(msgId)) return res.sendStatus(200);
  
  mensajesProcesados.add(msgId);
  const textoLimpo = texto.toLowerCase();

  // Filtro de Privacidad: Solo negocio
  const esNegocio = GATILHOS.some(g => textoLimpo.includes(g));
  const enConversa = conversaAtiva[phone] && Date.now() < conversaAtiva[phone];

  if (!esNegocio && !enConversa) return res.sendStatus(200);

  // Activación de memoria de negocio
  conversaAtiva[phone] = Date.now() + (10 * 60 * 1000);
  if (!estadoCliente[phone]) estadoCliente[phone] = { operacion: "remesa", monto: null, destino: null, municipio: null };
  let estado = estadoCliente[phone];

  // Captura automática de datos para los gráficos
  const matchMonto = texto.match(/\b\d{1,5}\b/);
  if (matchMonto && !estado.monto) estado.monto = matchMonto[0];

  const numeros = texto.replace(/\D/g, "");
  if (numeros.length === 16 || (numeros.length >= 8 && numeros.length <= 11)) estado.destino = numeros;

  for (const m of MUNICIPIOS_LISTA) { if (textoLimpo.includes(m)) estado.municipio = m; }

  // Respuesta y Registro
  const respuesta = await responderIA(texto, estado);
  await enviarMensaje(phone, respuesta);

  await salvarEnGoogleSheets({
    phone,
    operacion: estado.operacion,
    monto: estado.monto,
    destino: estado.destino,
    municipio: estado.municipio,
    tasa: 115
  });

  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("🚀 CRM YordaBot Activo"));
app.listen(PORT, "0.0.0.0", () => console.log(`Online en puerto ${PORT}`));
