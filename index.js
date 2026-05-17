const express = require("express");
const axios = require("axios");
const xmlrpc = require("xmlrpc");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// VARIABLES
const { 
  OPENAI_API_KEY, ZAPI_INSTANCE, ZAPI_TOKEN,
  ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY 
} = process.env;

const TASA_CUP = parseFloat(process.env.TASA_CUP) || 115;
const mensajesProcesados = new Set();

// FUNCIÓN ODOO (No bloqueante)
function crearOdoo(datos) {
  try {
    const urlLimpia = (ODOO_URL || "").replace(/\/$/, "");
    if (!urlLimpia || !ODOO_DB) return;

    const common = xmlrpc.createSecureClient(`${urlLimpia}/xmlrpc/2/common`);
    const models = xmlrpc.createSecureClient(`${urlLimpia}/xmlrpc/2/object`);

    common.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}], (err, uid) => {
      if (err || !uid) return console.log("⚠️ Odoo Auth falló, pero el bot sigue.");

      models.methodCall('execute_kw', [
        ODOO_DB, uid, ODOO_API_KEY,
        'crm.lead', 'create', [{
          name: `WA: ${datos.phone} (${datos.monto || 'Consulta'})`,
          partner_name: datos.phone,
          description: datos.mensaje,
          type: 'opportunity',
          priority: '2'
        }]
      ], (err) => {
        if (!err) console.log("✅ Odoo: Lead creado.");
      });
    });
  } catch (e) { console.log("⚠️ Error Odoo."); }
}

/* =========================
   WEBHOOK PRINCIPAL
========================== */
app.post("/webhook", async (req, res) => {
  const body = req.body;
  const phone = body.phone;
  const textoOriginal = body.text?.message || "";
  const fromMe = body.fromMe;

  // 1. Validaciones de entrada
  if (!phone || body.isGroup || fromMe) return res.sendStatus(200);

  // Evitar duplicados
  if (mensajesProcesados.has(body.messageId)) return res.sendStatus(200);
  mensajesProcesados.add(body.messageId);

  console.log(`📩 Mensaje de ${phone}: ${textoOriginal}`);

  // 2. Gatillos (Añadido saludos para que siempre responda)
  const gatillos = ["remesa", "tasa", "envio", "recarga", "precio", "cuanto", "hola", "buenos", "buenas", "info"];
  const esNegocio = gatillos.some(g => textoOriginal.toLowerCase().includes(g));

  if (esNegocio) {
    // Intentar Odoo en segundo plano
    const montoMatch = textoOriginal.match(/\b\d+\b/);
    crearOdoo({ phone, mensaje: textoOriginal, monto: montoMatch ? montoMatch[0] : null });

    try {
      // 3. IA - Respuesta
      const ai = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `Eres YordaBot. Tasa: ${TASA_CUP} CUP por 1 BRL. Responde muy corto (máx 2 líneas).` },
          { role: "user", content: textoOriginal }
        ]
      }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, timeout: 10000 });

      const respuestaIA = ai.data.choices[0].message.content;

      // 4. Enviar WhatsApp vía Z-API
      await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
      { 
        phone: String(phone).replace(/\D/g, ""), 
        message: respuestaIA, 
        checkContact: false 
      }, { timeout: 12000 });

      console.log(`✅ Respondido a ${phone}`);

    } catch (e) {
      console.log(`❌ Error procesando: ${e.message}`);
      // Respuesta de cortesía si OpenAI o Z-API fallan
      await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
      { phone, message: "Hola, he recibido tu mensaje. En breve Yordanys te atenderá personalmente. 👌" })
      .catch(() => {});
    }
  }

  // Limpiar memoria cada 500 mensajes
  if (mensajesProcesados.size > 500) mensajesProcesados.clear();
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("🚀 YordaBot Online"));
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Servidor escuchando en puerto ${PORT}`));
