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
  console.log("✅ Conexión con Google Sheets establecida");
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
   MEMORIA RAM Y FILTROS
========================= */
const pausaHumana = {};
const conversaAtiva = {};
const estadoCliente = {};

const PAUSA_HUMANA_MS = 30 * 60 * 1000;
const CONVERSA_ATIVA_MS = 10 * 60 * 1000; // 10 min de memoria

const GATILHOS = ["remesa", "envio", "enviar", "transferencia", "cambio", "tasa", "real", "brl", "cup", "pix", "mlc", "recarga", "etecsa", "tarjeta", "cuanto esta", "precio"];
const MUNICIPIOS_LISTA = ["habana", "centro habana", "habana vieja", "cerro", "boyeros", "arroyo naranjo", "marianao", "playa", "guanabacoa"];

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
        { role: "system", content: `Eres YordaBot, asistente de remesas de Yordanys. Responde muy corto (máx 2 líneas). Contexto: ${JSON.stringify(estado)}` },
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
   WEBHOOK (LOGICA DISCRETA)
========================= */
app.post("/webhook", async (req, res) => {
  const body = req.body;
  const phone = String(body.phone || "");
  const texto = body?.text?.message || "";

  if (!phone || body.isGroup || (body.fromMe && body.fromApi)) return res.sendStatus(200);

  // Si tú respondes manualmente, el bot se calla por 30 minutos
  if (body.fromMe) {
    pausaHumana[phone] = Date.now() + PAUSA_HUMANA_MS;
    return res.sendStatus(200);
  }

  if (pausaHumana[phone] && Date.now() < pausaHumana[phone]) return res.sendStatus(200);

  const textoLimpo = texto.toLowerCase();
  
  // FILTRO DE DISCRECIÓN: ¿Es mensaje de negocio o personal?
  const tieneGatillo = GATILHOS.some(g => contemPalavra(textoLimpo, g));
  const enConversaNegocio = conversaAtiva[phone] && Date.now() < conversaAtiva[phone];

  // Si no menciona negocio y no estamos en medio de una venta, NO RESPONDER
  if (!tieneGatillo && !enConversaNegocio) {
    return res.sendStatus(200); 
  }

  // Si detecta negocio, activamos memoria por 10 minutos
  conversaAtiva[phone] = Date.now() + CONVERSA_ATIVA_MS;
  let estado = getEstado(phone);

  // Extracción de datos inteligente
  const matchMonto = texto.match(/\b\d{1,5}\b/);
  if (matchMonto && !estado.monto) estado.monto = matchMonto[0];

  const numeros = texto.replace(/\D/g, "");
  if (numeros.length === 16) estado.destino = numeros;
  else if (numeros.length >= 8 && numeros.length <= 11) estado.destino = numeros;

  for (const m of MUNICIPIOS_LISTA) {
    if (textoLimpo.includes(m)) estado.municipio = m;
  }

  if (textoLimpo.includes("remesa")) estado.operacion = "remesa";
  if (textoLimpo.includes("recarga")) estado.operacion = "recarga";

  // Responder y Guardar
  const respuesta = await responderIA(texto, estado);
  await enviarMensaje(phone, respuesta);

  await salvarEnGoogleSheets({
    phone,
    operacion: estado.operacion,
    monto: estado.monto,
    destino: estado.destino,
    municipio: estado.municipio
  });

  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("🚀 YordaBot CRM Discreto Online ✅"));

app.listen(PORT, "0.0.0.0", () => console.log(`Servidor activo en puerto ${PORT}`));
