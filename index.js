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

// FUNCIÓN ODOO (XML-RPC)
function registrarEnOdoo(datos) {
  try {
    const urlLimpia = (ODOO_URL || "").replace(/\/$/, "");
    const common = xmlrpc.createSecureClient(`${urlLimpia}/xmlrpc/2/common`);
    const models = xmlrpc.createSecureClient(`${urlLimpia}/xmlrpc/2/object`);

    common.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}], (err, uid) => {
      if (err || !uid) return console.log("❌ Error Auth Odoo");

      models.methodCall('execute_kw', [
        ODOO_DB, uid, ODOO_API_KEY,
        'crm.lead', 'create', [{
          name: `WA: ${datos.phone} (${datos.monto || 'Consulta'})`,
          partner_name: datos.phone,
          description: datos.mensaje,
          type: 'opportunity'
        }]
      ], (err, result) => {
        if (!err) console.log(`✅ Oportunidad en Odoo creada ID: ${result}`);
      });
    });
  } catch (e) { console.log("⚠️ Error Odoo"); }
}

/* =========================
   WEBHOOK PRINCIPAL
========================== */
app.post("/webhook", async (req, res) => {
  const { phone, text, fromMe, isGroup, messageId } = req.body;
  const msgOriginal = text?.message || "";

  if (!phone || isGroup || fromMe || mensajesProcesados.has(messageId)) {
    return res.sendStatus(200);
  }

  const textoLimpo = msgOriginal.toLowerCase();
  const gatillos = ["remesa", "tasa", "envio", "recarga", "precio", "cuanto", "hola", "pix"];
  const esNegocio = gatillos.some(g => textoLimpo.includes(g));

  if (esNegocio) {
    mensajesProcesados.add(messageId);
    console.log(`💼 Negocio detectado de ${phone}`);

    // 1. Odoo (en segundo plano)
    const monto = msgOriginal.match(/\b\d+\b/)?.[0] || "0";
    registrarEnOdoo({ phone, mensaje: msgOriginal, monto });

    try {
      // 2. Respuesta IA
      const ai = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `Eres YordaBot. Tasa: ${TASA_CUP} CUP por 1 BRL. Responde corto (2 líneas).` },
          { role: "user", content: msgOriginal }
        ]
      }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, timeout: 10000 });

      const respuestaIA = ai.data.choices[0].message.content;

      // 3. Enviar WhatsApp (LIMPIO de Client-Token para evitar error 400)
      await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
      { 
        phone: String(phone).replace(/\D/g, ""), 
        message: respuestaIA,
        checkContact: false 
      }, { timeout: 15000 });

      console.log(`✅ Respondido a ${phone}`);

    } catch (e) {
      console.log(`❌ Error Z-API (400): ${e.message}`);
    }
  }

  if (mensajesProcesados.size > 500) mensajesProcesados.clear();
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("🚀 YordaBot Online"));
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Servidor activo en puerto ${PORT}`));
