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

// FUNCIÓN PARA ODOO
function crearOdoo(datos) {
  try {
    const url = (ODOO_URL || "").replace(/\/$/, "");
    if (!url || !ODOO_DB) return;
    const common = xmlrpc.createSecureClient(`${url}/xmlrpc/2/common`);
    const models = xmlrpc.createSecureClient(`${url}/xmlrpc/2/object`);
    common.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}], (err, uid) => {
      if (uid) {
        models.methodCall('execute_kw', [ODOO_DB, uid, ODOO_API_KEY, 'crm.lead', 'create', [{
          name: `WA: ${datos.phone}`, partner_name: datos.phone, description: datos.msg, type: 'opportunity'
        }]], () => console.log("📊 Odoo: Oportunidad creada con éxito."));
      }
    });
  } catch (e) { console.log("⚠️ Odoo: Fallo de conexión."); }
}

/* =========================
   WEBHOOK CON LOGS ACTIVOS
========================== */
app.post("/webhook", async (req, res) => {
  const body = req.body;
  
  // LOG DE ENTRADA: Si ves esto en Railway, la conexión con Z-API es correcta.
  console.log("-----------------------------------------");
  console.log("📩 EVENTO RECIBIDO DESDE Z-API");

  const phone = body.phone;
  const msg = body.text?.message || "";
  const fromMe = body.fromMe;

  if (!phone || body.isGroup || fromMe) {
    console.log("⏩ Mensaje ignorado (Grupo o enviado por el bot).");
    return res.sendStatus(200);
  }

  console.log(`👤 Cliente: ${phone}`);
  console.log(`💬 Mensaje: "${msg}"`);

  if (mensajesProcesados.has(body.messageId)) {
    return res.sendStatus(200);
  }
  mensajesProcesados.add(body.messageId);

  // FILTRO DE NEGOCIO (Gatillos)
  const gatillos = ["remesa", "tasa", "envio", "recarga", "precio", "cuanto", "hola", "pix"];
  const esNegocio = gatillos.some(g => msg.toLowerCase().includes(g));

  if (esNegocio) {
    console.log("💼 Negocio detectado. Procesando...");
    
    // Sincronizar con Odoo
    crearOdoo({ phone, msg });

    try {
      // IA
      const ai = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `Eres YordaBot. Tasa: ${TASA_CUP} CUP por 1 BRL. Responde muy corto.` },
          { role: "user", content: msg }
        ]
      }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, timeout: 8000 });

      const respuestaIA = ai.data.choices[0].message.content;
      console.log(`🤖 IA: "${respuestaIA}"`);

      // WhatsApp
      await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
      { phone, message: respuestaIA, checkContact: false }, 
      { timeout: 10000 });

      console.log("✅ Respuesta enviada satisfactoriamente.");
    } catch (e) {
      console.log(`❌ Error: ${e.message}`);
      // Respuesta de respaldo
      await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
      { phone, message: "Hola, he recibido tu mensaje. En breve Yordanys te atenderá. 👌", checkContact: false })
      .catch(() => console.log("❌ Error crítico: Z-API no responde."));
    }
  } else {
    console.log("⏩ Mensaje personal. El bot no intervendrá.");
  }

  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("YordaBot ONLINE 🚀"));
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Servidor escuchando en puerto ${PORT}`));
