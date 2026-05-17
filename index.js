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
  ZAPI_CLIENT_TOKEN,
  ODOO_URL, 
  ODOO_DB, 
  ODOO_USER, 
  ODOO_API_KEY 
} = process.env;

const TASA_CUP = parseFloat(process.env.TASA_CUP) || 115;

/* =========================
   MEMORIA Y FILTROS
========================= */
const estadoCliente = {};
const mensajesProcesados = new Set();
const GATILHOS = ["remesa", "envio", "tasa", "real", "brl", "cup", "pix", "recarga", "precio", "cuanto", "tarjeta"];

/* =========================
   CEREBRO ODOO (XML-RPC)
========================= */
function registrarEnOdoo(datos) {
  try {
    const urlLimpia = ODOO_URL.replace(/\/$/, "");
    const common = xmlrpc.createSecureClient(`${urlLimpia}/xmlrpc/2/common`);
    const models = xmlrpc.createSecureClient(`${urlLimpia}/xmlrpc/2/object`);

    common.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}], (err, uid) => {
      if (err || !uid) return console.log("❌ Error Auth Odoo:", err);

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
        if (err) console.log("❌ Error Odoo Lead:", err);
        else console.log("✅ Oportunidad creada en Odoo ID:", result);
      });
    });
  } catch (e) {
    console.log("⚠️ Fallo crítico en conexión Odoo");
  }
}

/* =========================
   WEBHOOK PRINCIPAL
========================= */
app.post("/webhook", async (req, res) => {
  const { phone, text, fromMe, isGroup, messageId } = req.body;
  const msgOriginal = text?.message || "";

  // 1. Validaciones iniciales
  if (!phone || isGroup || fromMe || mensajesProcesados.has(messageId)) {
    return res.sendStatus(200);
  }

  const textoLimpo = msgOriginal.toLowerCase();
  const esNegocio = GATILHOS.some(g => textoLimpo.includes(g));

  // Filtro de Privacidad: Solo responde si es negocio o hay una charla activa
  if (!esNegocio && !estadoCliente[phone]) return res.sendStatus(200);

  mensajesProcesados.add(messageId);
  if (!estadoCliente[phone]) estadoCliente[phone] = { monto: 0 };
  let est = estadoCliente[phone];

  // 2. Extraer datos para el CRM
  const matchMonto = msgOriginal.match(/\b\d{1,5}\b/);
  if (matchMonto) est.monto = matchMonto[0];

  // 3. Crear Oportunidad en Odoo
  registrarEnOdoo({
    phone,
    mensaje: msgOriginal,
    monto: est.monto
  });

  // 4. Obtener Respuesta de IA
  try {
    const ai = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `Eres YordaBot, asistente de remesas. Tasa: ${TASA_CUP} CUP/BRL. Responde corto (máx 2 líneas).` 
        },
        { role: "user", content: msgOriginal }
      ]
    }, { 
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      timeout: 10000 
    });

    const respuestaIA = ai.data.choices[0].message.content;

    // 5. Enviar por WhatsApp vía Z-API
    await axios({
      method: 'post',
      url: `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      data: { 
        phone: String(phone).replace(/\D/g, ""), 
        message: respuestaIA,
        checkContact: false 
      },
      headers: { 
        'Content-Type': 'application/json',
        'Client-Token': ZAPI_CLIENT_TOKEN || ""
      },
      timeout: 15000
    });

    console.log(`✅ Respondido a ${phone}`);

  } catch (e) {
    console.log("❌ Error en flujo de respuesta/envío");
  }

  // Limpiar memoria de IDs para no saturar Railway
  if (mensajesProcesados.size > 1000) mensajesProcesados.clear();

  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("🚀 YordaBot Odoo CRM Online"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor activo en puerto ${PORT}`);
});
