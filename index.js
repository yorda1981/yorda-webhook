const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// VARIABLES DE ENTORNO
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// CONFIGURACIÓN DE NEGOCIO (Cámbialo según tu preferencia)
const TASA_CUP = 115; // Cuánto das por cada 1 Real
const COMISION = 0.05; // Tu ganancia (5%)

let sheets;
try {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(GOOGLE_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheets = google.sheets({ version: "v4", auth });
} catch (e) { console.log("Error Sheets"); }

let estadoCliente = {};
const GATILHOS = ["remesa", "envio", "tasa", "real", "brl", "cup", "pix", "recarga", "precio"];

async function salvarEnGoogleSheets(d) {
  if (!sheets) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Hoja 1!A:I",
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[
          new Date().toLocaleString("es-ES", { timeZone: "America/Sao_Paulo" }),
          d.phone,
          d.tipo || "Remesa",
          d.montoBRL || 0,
          d.montoCUP || 0,
          d.destino || "",
          "🟠 Pendiente",
          d.lucro || 0,
          d.municipio || ""
        ]],
      },
    });
  } catch (err) { console.log("Error escribiendo en Sheets"); }
}

async function responderIA(msg, est) {
  try {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Eres YordaBot. Ayudas con remesas. Tasa: ${TASA_CUP}. Responde corto. Si el cliente dio un monto, confírmale cuánto recibirá en Cuba.` },
        { role: "user", content: `Cliente: ${msg}. Estado actual: ${JSON.stringify(est)}` }
      ]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    return res.data.choices[0].message.content;
  } catch (e) { return "Dime 👍"; }
}

app.post("/webhook", async (req, res) => {
  const body = req.body;
  const phone = body.phone;
  const texto = body.text?.message || "";

  if (!phone || body.isGroup || body.fromMe) return res.sendStatus(200);

  const textoLimpo = texto.toLowerCase();
  const esNegocio = GATILHOS.some(g => textoLimpo.includes(g));

  if (!esNegocio && !estadoCliente[phone]) return res.sendStatus(200);

  // CONECTANDO EL CEREBRO: Procesamiento de datos
  if (!estadoCliente[phone]) estadoCliente[phone] = { montoBRL: 0 };
  let est = estadoCliente[phone];

  // Extraer monto y calcular
  const match = texto.match(/\b\d{1,5}\b/);
  if (match) {
    est.montoBRL = parseInt(match[0]);
    est.montoCUP = est.montoBRL * TASA_CUP;
    est.lucro = est.montoBRL * COMISION;
  }

  // Extraer destino (tarjeta o cel)
  const num = texto.replace(/\D/g, "");
  if (num.length >= 8) est.destino = num;

  const respuesta = await responderIA(texto, est);
  
  await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
  { phone, message: respuesta });

  await salvarEnGoogleSheets({
    phone,
    tipo: textoLimpo.includes("recarga") ? "Recarga" : "Remesa",
    montoBRL: est.montoBRL,
    montoCUP: est.montoCUP,
    destino: est.destino,
    lucro: est.lucro
  });

  res.sendStatus(200);
});

app.listen(PORT, "0.0.0.0", () => console.log("Cerebro conectado"));
