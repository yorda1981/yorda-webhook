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
  if (!message) return;

  // Limpiar el teléfono para asegurar que Z-API lo acepte (solo números)
  const cleanPhone = String(phone).replace(/\D/g, "");

  try {
    await axios({
      method: 'post',
      url: `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      data: { 
        phone: cleanPhone, 
        message: message 
      },
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' }
    });
    console.log(`✅ Respondido con éxito a ${cleanPhone}`);
  } catch (e) {
    console.log(`❌ Error Z-API (400): Revisa si el número ${cleanPhone} es válido o si la instancia tiene saldo/permisos.`);
    // console.log(e.response?.data); // Descomenta esta línea solo si necesitas ver el detalle técnico del error
  }
}

async function obtenerRespuestaIA(mensajeUsuario, datosEstado) {
  try {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `Eres YordaBot. Tasa: ${TASA_CUP} CUP/1 BRL. Responde en 1 o 2 líneas máximo. Muy amable.` 
        },
        { role: "user", content: `Mensaje: ${mensajeUsuario}. Datos: ${JSON.stringify(datosEstado)}` }
      ]
    }, { 
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      timeout: 10000 
    });
    return res.data.choices[0].message.content;
  } catch (e) {
    return "Hola, dime cómo puedo ayudarte con tu remesa. 👌";
  }
}

/* =========================
   WEBHOOK
========================= */
app.post("/webhook", async (req, res) => {
  const { phone, text, fromMe, isGroup, messageId } = req.body;
  const mensajeOriginal = text?.message || "";

  if (!phone || isGroup || fromMe || mensajesProcesados.has(messageId)) {
    return res.sendStatus(200);
  }

  const textoLimpo = mensajeOriginal.toLowerCase();
  const esNegocio = GATILHOS.some(g => textoLimpo.includes(g));

  if (!esNegocio && !estadoCliente[phone]) return res.sendStatus(200);

  mensajesProcesados.add(messageId);
  if (!estadoCliente[phone]) estadoCliente[phone] = { montoBRL: 0 };
  let est = estadoCliente[phone];

  // Captura de datos
  const matchMonto = mensajeOriginal.match(/\b\d{1,5}\b/);
  if (matchMonto) {
    est.montoBRL = parseInt(matchMonto[0]);
    est.montoCUP = est.montoBRL * TASA_CUP;
    est.lucro = est.montoBRL * COMISION_PCT;
  }

  const respuesta = await obtenerRespuestaIA(mensajeOriginal, est);
  await enviarWhatsApp(phone, respuesta);

  // Registro en Sheets
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
          "", 
          "🟠 Pendiente", 
          est.lucro || 0,
          ""
        ]] 
      }
    }).catch(() => {});
  }

  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("YordaBot Activo"));
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Servidor activo en puerto ${PORT}`));
