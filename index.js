const express = require("express");
const axios = require("axios");
const xmlrpc = require("xmlrpc");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const { 
  OPENAI_API_KEY, ZAPI_INSTANCE, ZAPI_TOKEN,
  ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY 
} = process.env;

const TASA_CUP = parseFloat(process.env.TASA_CUP) || 115;
const mensajesProcesados = new Set();

// FUNCIÓN ODOO
function registrarEnOdoo(datos) {
  try {
    const urlLimpia = (ODOO_URL || "").replace(/\/$/, "");
    const common = xmlrpc.createSecureClient(`${urlLimpia}/xmlrpc/2/common`);
    const models = xmlrpc.createSecureClient(`${urlLimpia}/xmlrpc/2/object`);

    common.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}], (err, uid) => {
      if (err || !uid) return console.log("❌ Odoo Auth Error");
      models.methodCall('execute_kw', [ODOO_DB, uid, ODOO_API_KEY, 'crm.lead', 'create', [{
        name: `WhatsApp: ${datos.phone}`,
        partner_name: datos.phone,
        description: datos.mensaje,
        type: 'opportunity'
      }]], (err, res) => {
        if (!err) console.log(`✅ Oportunidad en Odoo creada ID: ${res}`);
      });
    });
  } catch (e) { console.log("⚠️ Odoo Falló"); }
}

// WEBHOOK
app.post("/webhook", async (req, res) => {
  const { phone, text, fromMe, isGroup, messageId } = req.body;
  const msg = text?.message || "";

  if (!phone || isGroup || fromMe || mensajesProcesados.has(messageId)) return res.sendStatus(200);
  mensajesProcesados.add(messageId);

  const gatillos = ["remesa", "tasa", "envio", "recarga", "precio", "cuanto", "hola", "pix"];
  if (gatillos.some(g => msg.toLowerCase().includes(g))) {
    
    console.log(`💼 Negocio detectado de ${phone}`);
    registrarEnOdoo({ phone, mensaje: msg });

    try {
      // 1. IA
      const ai = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: `Eres YordaBot. Tasa: ${TASA_CUP} CUP/BRL. Responde corto.` }, { role: "user", content: msg }]
      }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, timeout: 10000 });

      // 2. WHATSAPP (Versión Ultra-Limpia)
      await axios({
        method: 'post',
        url: `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
        data: { 
          phone: String(phone).replace(/\D/g, ""), 
          message: ai.data.choices[0].message.content,
          checkContact: false 
        },
        timeout: 15000
      });

      console.log(`✅ Respuesta enviada a ${phone}`);
    } catch (e) {
      console.log(`❌ Error Z-API (400): ${e.message}`);
    }
  }
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("YordaBot Online"));
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Servidor activo en puerto ${PORT}`));
