const express = require("express");
const axios = require("axios");
const xmlrpc = require("xmlrpc");

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
  ODOO_URL, 
  ODOO_DB, 
  ODOO_USER, 
  ODOO_API_KEY 
} = process.env;

const TASA_CUP = parseFloat(process.env.TASA_CUP) || 115;

/* =========================
   CEREBRO ODOO (CON PROTECCIÓN)
========================= */
function registrarEnOdoo(datos) {
  try {
    // Limpiar URL para evitar errores de formato
    const urlLimpia = (ODOO_URL || "").replace(/\/$/, "");
    if (!urlLimpia || !ODOO_DB || !ODOO_API_KEY) {
      return console.log("⚠️ Faltan variables de Odoo. Lead no creado.");
    }

    const common = xmlrpc.createSecureClient(`${urlLimpia}/xmlrpc/2/common`);
    const models = xmlrpc.createSecureClient(`${urlLimpia}/xmlrpc/2/object`);

    // Autenticación asíncrona para no bloquear el servidor
    common.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}], (err, uid) => {
      if (err) return console.log("❌ Error conexión Odoo:", err.message);
      if (!uid) return console.log("❌ Auth Odoo falló: Revisa usuario/API Key");

      const lead = {
        name: `WhatsApp: ${datos.phone} (${datos.monto || 'Consulta'})`,
        partner_name: datos.phone,
        description: `Mensaje: ${datos.mensaje}`,
        type: 'opportunity',
        priority: '2',
      };

      models.methodCall('execute_kw', [
        ODOO_DB, uid, ODOO_API_KEY,
        'crm.lead', 'create', [lead]
      ], (err, result) => {
        if (err) console.log("❌ Error creando Lead en Odoo:", err.message);
        else console.log("✅ Oportunidad creada en Odoo ID:", result);
      });
    });
  } catch (error) {
    console.log("⚠️ Error crítico Odoo:", error.message);
  }
}

/* =========================
   WEBHOOK PRINCIPAL
========================= */
const mensajesProcesados = new Set();
const GATILHOS = ["remesa", "tasa", "envio", "recarga", "cup", "brl", "real", "pix", "precio"];

app.post("/webhook", async (req, res) => {
  const { phone, text, fromMe, isGroup, messageId } = req.body;
  const mensajeOriginal = text?.message || "";

  // 1. Validaciones básicas
  if (!phone || isGroup || fromMe || mensajesProcesados.has(messageId)) {
    return res.sendStatus(200);
  }

  const textoLimpo = mensajeOriginal.toLowerCase();
  const esNegocio = GATILHOS.some(g => textoLimpo.includes(g));

  if (esNegocio) {
    mensajesProcesados.add(messageId);
    console.log(`💼 Negocio detectado: ${phone}`);

    // 2. Extraer monto y crear en Odoo (en segundo plano)
    const monto = mensajeOriginal.match(/\b\d+\b/)?.[0] || "0";
    registrarEnOdoo({
      phone,
      mensaje: mensajeOriginal,
      monto
    });

    // 3. Respuesta con IA y Z-API
    try {
      const ai = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `Eres YordaBot. Tasa: ${TASA_CUP} CUP por 1 BRL. Responde corto y profesional en 2 líneas.` },
          { role: "user", content: mensajeOriginal }
        ]
      }, { 
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        timeout: 12000 
      });

      const respuestaIA = ai.data.choices[0].message.content;

      await axios.post(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, 
      { 
        phone: String(phone).replace(/\D/g, ""), 
        message: respuestaIA, 
        checkContact: false 
      }, { timeout: 15000 });

      console.log(`✅ Respondido con éxito a ${phone}`);
    } catch (e) {
      console.log("❌ Error en flujo IA/WhatsApp:", e.message);
    }
  }

  // Limpiar memoria de IDs cada 500 mensajes
  if (mensajesProcesados.size > 500) mensajesProcesados.clear();
  
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("🚀 YordaBot Odoo CRM Online"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor activo en puerto ${PORT}`);
});
