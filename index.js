const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

/* =========================
   VARIABLES DE ENTORNO
========================= */
const { 
  OPENAI_API_KEY, 
  ZAPI_INSTANCE, 
  ZAPI_TOKEN, 
  SPREADSHEET_ID, 
  GOOGLE_SERVICE_ACCOUNT_JSON 
} = process.env;

const TASA_CUP = parseFloat(process.env.TASA_CUP) || 115;
const COMISION_PCT = parseFloat(process.env.COMISION) || 0.05;

/* =========================
   CONFIGURACIÓN GOOGLE SHEETS
========================= */
let sheets;
try {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheets = google.sheets({ version: "v4", auth });
  console.log("✅ Cerebro de Sheets Conectado");
} catch (e) { 
  console.log("⚠️ Error en Sheets, pero el bot seguirá funcionando"); 
}

/* =========================
   MEMORIA Y GATILHOS
========================= */
const estadoCliente = {};
const mensajesProcesados = new Set();
const GATILHOS = ["remesa", "envio", "tasa", "real", "brl", "cup", "pix", "recarga", "precio", "cuanto", "tarjeta"];

/* =========================
   FUNCIONES DE APOYO
========================= */
async function enviarWhatsApp(phone, message) {
  try {
    await axios({
      method: 'post',
      url: `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      data: { phone, message },
      timeout: 20000, // 20 segundos de espera para evitar cortes de red
      headers: { 'Content-Type': 'application/json' }
    });
    console.log(`✅ Respondido a ${phone}`);
  } catch (e) {
    console.log(`❌ Error al enviar a Z-API: ${e.message}`);
  }
}

async function obtenerRespuestaIA(mensajeUsuario, datosEstado) {
  try {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `Eres YordaBot, asistente de remesas profesional. Tasa: ${TASA_CUP} CUP por 1 BRL. Responde muy corto (máx 2 líneas). Si detectas un monto en BRL, confirma cuánto es en CUP.` 
        },
        { role: "user", content: `Mensaje: ${mensajeUsuario}. Datos actuales: ${JSON.stringify(datosEstado)}` }
      ]
    }, { 
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      timeout: 15000 
    });
    return res.data.choices[0].message.content;
  } catch (e) {
    return "Dime 👍";
  }
}

/* =========================
   WEBHOOK PRINCIPAL
========================= */
app.post("/webhook", async (req, res) => {
  const { phone, text, fromMe, isGroup, messageId } = req.body;
  const mensajeOriginal = text?.message || "";

  // 1. Validaciones de entrada
  if (!phone || isGroup || fromMe || mensajesProcesados.has(messageId)) {
    return res.sendStatus(200);
  }

  const textoLimpo = mensajeOriginal.toLowerCase();
  const esNegocio = GATILHOS.some(g => textoLimpo.includes(g));

  // 2. Filtro de Privacidad
  if (!esNegocio && !estadoCliente[phone]) return res.sendStatus(200);

  mensajesProcesados.add(messageId);
  if (!estadoCliente[phone]) estadoCliente[phone] = { montoBRL: 0, destino: "" };
  let est = estadoCliente[phone];

  // 3. Procesar datos financieros
  const matchMonto = mensajeOriginal.match(/\b\d{1,5}\b/);
  if (matchMonto) {
    est.montoBRL = parseInt(matchMonto[0]);
    est.montoCUP = est.montoBRL * TASA_CUP;
    est.lucro = est.montoBRL * COMISION_PCT;
  }

  const numeros = mensajeOriginal.replace(/\D/g, "");
  if (numeros.length >= 8) est.destino = numeros;

  // 4. Obtener Respuesta e Enviar
  const respuesta = await obtenerRespuestaIA(mensajeOriginal, est);
  await enviarWhatsApp(phone, respuesta);

  // 5. Guardar en Google Sheets (Dashboard Profesional)
  if (sheets && est.montoBRL > 0) {
    sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Hoja 1!A:I",
      valueInputOption: "USER_ENTERED",
      resource: { 
        values: [[
          new Date().toLocaleString("es-ES"), 
          phone, 
          textoLimpo.includes("recarga") ? "Recarga" : "Remesa", 
          est.montoBRL, 
          est.montoCUP || 0, 
          est.destino || "", 
          "🟠 Pendiente", 
          est.lucro || 0,
          "" // Columna para notas manuales
        ]] 
      }
    }).catch(e => console.log("⚠️ No se pudo guardar la fila en Sheets"));
  }

  // Limpiar memoria de mensajes procesados cada hora para no saturar
  if (mensajesProcesados.size > 500) mensajesProcesados.clear();

  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("🚀 YordaBot CRM Profesional Online"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor activo en puerto ${PORT}`);
});
