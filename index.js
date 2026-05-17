const express = require("express");
const axios = require("axios");
const xmlrpc = require("xmlrpc");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

/* =========================
   VARIABLES (Configura no Railway)
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
   CEREBRO ODOO (XML-RPC)
========================= */
function registrarEnOdoo(datos) {
  try {
    const urlLimpia = (ODOO_URL || "").replace(/\/$/, "");
    if (!urlLimpia) return console.log("⚠️ ODOO_URL não configurada.");

    const common = xmlrpc.createSecureClient(`${urlLimpia}/xmlrpc/2/common`);
    const models = xmlrpc.createSecureClient(`${urlLimpia}/xmlrpc/2/object`);

    common.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}], (err, uid) => {
      if (err) return console.log("❌ Erro Auth Odoo:", err.message);
      if (!uid) return console.log("❌ Credenciais Odoo incorretas.");

      const lead = {
        name: `WhatsApp: ${datos.phone} (${datos.monto || 'Consulta'})`,
        partner_name: datos.phone,
        description: `Mensagem: ${datos.mensaje}`,
        type: 'opportunity',
        priority: '2',
      };

      models.methodCall('execute_kw', [
        ODOO_DB, uid, ODOO_API_KEY,
        'crm.lead', 'create', [lead]
      ], (err, result) => {
        if (err) console.log("❌ Erro ao criar Lead no Odoo:", err.message);
        else console.log("✅ Oportunidade criada no Odoo ID:", result);
      });
    });
  } catch (error) {
    console.log("⚠️ Erro crítico na ligação ao Odoo:", error.message);
  }
}

/* =========================
   WEBHOOK PRINCIPAL
========================= */
const mensajesProcesados = new Set();

app.post("/webhook", async (req, res) => {
  const { phone, text, fromMe, isGroup, messageId } = req.body;
  const mensajeOriginal = text?.message || "";

  // 1. Validações de entrada
  if (!phone || isGroup || fromMe || mensajesProcesados.has(messageId)) {
    return res.sendStatus(200);
  }

  const textoLimpo = mensajeOriginal.toLowerCase();
  const gatillos = ["remesa", "tasa", "envio", "recarga", "cup", "brl", "real", "pix"];
  const esNegocio = gatillos.some(g => textoLimpo.includes(g));

  if (esNegocio) {
    mensajesProcesados.add(messageId);
    console.log(`💼 Negócio detectado: ${phone}`);

    // 2. Criar no Odoo (em background)
    const monto = mensajeOriginal.match(/\b\d+\b/)?.[0] || "0";
    registrarEnOdoo({
      phone,
      mensaje: mensajeOriginal,
      monto
    });

    // 3. Resposta com IA e Z-API
    try {
      const ai = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `És o YordaBot. Taxa: ${TASA_CUP} CUP por 1 BRL. Responde curto e profissional em 2 linhas.` },
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

      console.log(`✅ Respondido a ${phone}`);
    } catch (e) {
      console.log("❌ Erro no fluxo IA/WhatsApp:", e.message);
    }
  }

  // Limpeza de memória
  if (mensajesProcesados.size > 500) mensajesProcesados.clear();
  
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("🚀 YordaBot Odoo Online"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor ativo na porta ${PORT}`);
});
