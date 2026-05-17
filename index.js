const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

/* =========================
   VARIABLES DE ENTORNO
========================= */

const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const ZAPI_INSTANCE     = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN        = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET;

/* =========================
   MEMORIA EN RAM Y BLOQUEOS
========================= */

const pausaHumana   = {}; // phone → timestamp fin pausa
const conversaAtiva = {}; // phone → timestamp expiración
const estadoCliente = {}; // phone → objeto estado
const locks         = {}; // phone → boolean (Evita condiciones de carrera)

/* =========================
   CONSTANTES
========================= */

const PAUSA_HUMANA_MS   = 30 * 60 * 1000;  // 30 min
const CONVERSA_ATIVA_MS =  5 * 60 * 1000;  // 5 min
const TTL_ESTADO_RAM    = 24 * 60 * 60 * 1000; // 24 horas para limpieza total

const GATILHOS = [
  "remesa", "remesas", "envio", "enviar",
  "transferencia", "transferência", "transferir",
  "cambio", "câmbio", "tasa", "taxa", "tasas", "taxas",
  "real", "reales", "brl", "cup", "usd",
  "dolar", "dólar", "pix", "mlc",
  "recarga", "saldo", "etecsa",
  "dinero", "dinheiro",
  "deposito", "depósito",
  "cartão", "cartao",
  "habana", "efectivo", "entrega"
];

const SAUDACOES = [
  "hola", "oi", "ola", "olá", "buenas",
  "bom dia", "boa tarde", "boa noite",
  "buen dia", "buenos dias",
  "buenas tardes", "buenas noches"
];

const MUNICIPIOS = [
  "habana", "centro habana", "habana vieja",
  "cerro", "boyeros", "arroyo naranjo", "marianao"
];

const PIX_CHAVE = "8becaaf5-f296-4cbc-a115-46e3d23b042a";
const PIX_NOME  = "YORDANYS RAFAEL SOSA REYES\nNubank";

/* =========================
   UTILIDADES Y ESCAPE REGEX
========================= */

function escapeRegex(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contemPalavra(texto, palabra) {
  const segura = escapeRegex(palabra);
  const regex = new RegExp(`(^|\\s)${segura}(\\s|$)`, "iu");
  return regex.test(texto);
}

/* =========================
   GESTIÓN DE ESTADO Y GARBAGE COLLECTOR
========================= */

function resetEstado(phone) {
  estadoCliente[phone] = {
    operacion:     null,
    etapa:         "inicio",
    moeda:         null,
    monto:         null,
    municipio:     null,
    tarjeta:       null,
    numero:        null,
    aguardando:    null,
    pixEnviado:    false,
    ultimoContato: Date.now()
  };
}

function getEstado(phone) {
  if (!estadoCliente[phone]) {
    resetEstado(phone);
  } else {
    estadoCliente[phone].ultimoContato = Date.now();
  }
  return estadoCliente[phone];
}

// 1 — GARBAGE COLLECTOR OPTIMIZADO (Sin bloqueos redundantes de locks)
setInterval(() => {
  const agora = Date.now();
  
  // Limpieza de estados huérfanos por inactividad prolongada
  for (const phone in estadoCliente) {
    if (agora - estadoCliente[phone].ultimoContato > TTL_ESTADO_RAM) {
      console.log(`[GC] Removiendo estado de: ${phone}`);
      delete estadoCliente[phone];
    }
  }

  // Limpieza de conversaciones activas ya expiradas
  for (const phone in conversaAtiva) {
    if (agora > conversaAtiva[phone]) {
      console.log(`[GC] Removiendo conversaAtiva expirada de: ${phone}`);
      delete conversaAtiva[phone];
    }
  }

  // Limpieza de pausas humanas obsoletas
  for (const phone in pausaHumana) {
    if (agora > pausaHumana[phone]) {
      console.log(`[GC] Removiendo pausaHumana terminada de: ${phone}`);
      delete pausaHumana[phone];
    }
  }
}, 60 * 60 * 1000); // Ejecución cada hora

/* =========================
   ENVIAR WHATSAPP (Con Timeout)
========================= */

async function enviarMensaje(phone, texto) {
  try {
    const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;

    const response = await axios.post(
      url,
      { phone, message: texto },
      { 
        headers: { "Client-Token": ZAPI_CLIENT_TOKEN, "Content-Type": "application/json" },
        timeout: 15000 
      }
    );

    console.log("ENVIADO:", response.data);
  } catch (error) {
    console.log("ERRO ZAPI:", error.response?.data || error.message);
  }
}

/* =========================
   OPENAI CHAT COMPLETIONS (Con Timeout)
========================= */

async function responderIA(mensagem, estado) {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Eres YordaBot. Asistente automatizado de remesas Cuba-Brasil.
REGLAS ACELERADAS:
- Responde en un máximo de 2 líneas.
- Sé natural, directo y amigable. No uses listas largas.
- Responde siempre en el mismo idioma del cliente.
- Usa el contexto para ver qué datos ya están guardados en el sistema y NO los vuelvas a preguntar.

Operaciones disponibles: 
1. transferencia (necesita monto y tarjeta de 16 dígitos)
2. entrega en mano (necesita monto y municipio de La Habana)
3. recarga ETECSA (necesita monto y número de teléfono)`
          },
          {
            role: "user",
            content: `CONTEXTO DEL CLIENTE EN SISTEMA:\n${JSON.stringify(estado, null, 2)}\n\nMENSAGEM DEL CLIENTE:\n${mensagem}`
          }
        ],
        temperature: 0.4
      },
      { 
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        timeout: 25000 
      }
    );

    return response.data.choices?.[0]?.message?.content?.trim() || "Dime 👍";

  } catch (error) {
    console.log("ERRO OPENAI:", error.response?.data || error.message);
    return "Dime 👍";
  }
}

/* =========================
   DETECTORES CONTEXTUALES
========================= */

function detectarOperacion(textoLimpo) {
  if (contemPalavra(textoLimpo, "recarga") || contemPalavra(textoLimpo, "etecsa"))
    return "recarga";

  if (contemPalavra(textoLimpo, "transferencia") || contemPalavra(textoLimpo, "transferência") || contemPalavra(textoLimpo, "transferir"))
    return "transferencia";

  if (contemPalavra(textoLimpo, "entrega") || contemPalavra(textoLimpo, "habana") || contemPalavra(textoLimpo, "efectivo"))
    return "entrega";

  return null;
}

function detectarMoeda(textoLimpo, estado) {
  if (contemPalavra(textoLimpo, "real") || contemPalavra(textoLimpo, "reales") || contemPalavra(textoLimpo, "brl")) {
    estado.moeda = "BRL";
  } else if (contemPalavra(textoLimpo, "usd") || contemPalavra(textoLimpo, "dolar") || contemPalavra(textoLimpo, "dólar")) {
    estado.moeda = "USD";
  }
}

function detectarMonto(texto, textoLimpo, estado) {
  const mencionaMoneda =
    contemPalavra(textoLimpo, "real")   ||
    contemPalavra(textoLimpo, "reales") ||
    contemPalavra(textoLimpo, "usd")    ||
    contemPalavra(textoLimpo, "cup");

  if (estado.etapa !== "esperando_monto" && !mencionaMoneda) return;

  const match = texto.match(/\b\d{1,6}([.,]\d{1,2})?\b/);
  if (match) estado.monto = match[0];
}

function detectarTarjeta(texto, estado) {
  if (estado.etapa !== "esperando_tarjeta") return;
  const soloDigitos = texto.replace(/\D/g, "");
  if (/^\d{16}$/.test(soloDigitos)) estado.tarjeta = soloDigitos;
}

function detectarMunicipio(textoLimpo, estado) {
  if (estado.etapa !== "esperando_municipio") return;
  for (const m of MUNICIPIOS) {
    if (textoLimpo.includes(m)) { estado.municipio = m; return; }
  }
}

function detectarNumeroRecarga(texto, estado) {
  if (estado.etapa !== "esperando_numero") return;
  const soloDigitos = texto.replace(/\D/g, "");
  if (/^\d{8,11}$/.test(soloDigitos)) estado.numero = soloDigitos;
}

/* =========================
   DISPARADOR PIX
========================= */

async function enviarPix(phone, estado) {
  estado.etapa      = "esperando_comprovante";
  estado.pixEnviado = true;
  estado.aguardando = "comprovante";
  await enviarMensaje(phone, PIX_CHAVE);
  await enviarMensaje(phone, PIX_NOME);
}

/* =========================
   FLUJOS ESTRUCTURADOS
========================= */

async function procesarTransferencia(phone, estado) {
  if (!estado.monto)   { estado.etapa = "esperando_monto";   await enviarMensaje(phone, "¿Cuántos reales deseas enviar?");          return true; }
  if (!estado.tarjeta) { estado.etapa = "esperando_tarjeta"; await enviarMensaje(phone, "Envíame el número de la tarjeta 👌");       return true; }
  if (!estado.pixEnviado) { await enviarPix(phone, estado); return true; }
  return false;
}

async function procesarEntrega(phone, estado) {
  if (!estado.monto)    { estado.etapa = "esperando_monto";    await enviarMensaje(phone, "¿Cuántos reales deseas enviar?");    return true; }
  if (!estado.municipio){ estado.etapa = "esperando_municipio";await enviarMensaje(phone, "¿A qué municipio de La Habana?");   return true; }
  if (!estado.pixEnviado) { await enviarPix(phone, estado); return true; }
  return false;
}

async function procesarRecarga(phone, estado) {
  if (!estado.monto)  { estado.etapa = "esperando_monto";  await enviarMensaje(phone, "¿De cuánto será la recarga?");         return true; }
  if (!estado.numero) { estado.etapa = "esperando_numero"; await enviarMensaje(phone, "Envíame el número a recargar 👌");      return true; }
  if (!estado.pixEnviado) { await enviarPix(phone, estado); return true; }
  return false;
}

/* =========================
   MIDDLEWARE AUTORIZACIÓN
========================= */

function verificarAutorizacao(req, res, next) {
  const headerSecret = req.headers["x-webhook-secret"];
  if (WEBHOOK_SECRET && headerSecret === WEBHOOK_SECRET) return next();

  const queryToken = req.query.token;
  if (WEBHOOK_SECRET && queryToken === WEBHOOK_SECRET) return next();

  const clientToken = req.headers["client-token"];
  if (ZAPI_CLIENT_TOKEN && clientToken === ZAPI_CLIENT_TOKEN) return next();

  console.log("AUTORIZAÇÃO NEGADA - IP:", req.ip);
  return res.sendStatus(401);
}

function saudacaoPorHora(hora) {
  if (hora >= 6  && hora < 12) return "Buen día 👋 ¿Cómo puedo ayudarte?";
  if (hora >= 12 && hora < 20) return "Buenas tardes 👋 ¿Cómo puedo ayudarte?";
  return "Buenas noches 👋 ¿Cómo puedo ayudarte?";
}

/* =========================
   WEBHOOK PRINCIPAL
========================= */

app.post("/webhook", verificarAutorizacao, async (req, res) => {
  const body = req.body;
  if (!body) return res.sendStatus(200);

  const phone = body.phone;
  if (!phone) return res.sendStatus(200);

  // 2 — PARSEO SEGURO DE FROMME (Booleano o String)
  const fromMe = body.fromMe === true || body.fromMe === "true";

  // --- CONTROL DE ANTI-LOOP ---
  if (body.fromApi === true && fromMe === true) {
    return res.sendStatus(200); 
  }

  // --- MANEJO DE CONCURRENCIA NO DESTRUCTIVO ---
  if (locks[phone]) {
    console.log("LOCK DETECTADO (Retrasando ejecución secuencial):", phone);
    await new Promise(resolve => setTimeout(resolve, 800));
    
    if (locks[phone]) {
      console.log("LOCK PERSISTENTE: Descartando payload redundante de:", phone);
      return res.sendStatus(200);
    }
  }

  locks[phone] = true;

  try {
    // Pausa humana si el operador responde desde WhatsApp corporativo
    if (fromMe) {
      pausaHumana[phone] = Date.now() + PAUSA_HUMANA_MS;
      console.log("PAUSA HUMANA ACTIVADA POR OPERADOR:", phone);
      return res.sendStatus(200);
    }

    // 3 — COMPROBACIÓN DE STATUS SANITIZADA (Case-Insensitive)
    const status = String(body.status || "").toUpperCase();
    if (
      body.isGroup      === true ||
      body.isNewsletter === true ||
      body.isEdit       === true ||
      (status && status !== "RECEIVED")
    ) {
      return res.sendStatus(200);
    }

    const texto = body?.text?.message || "";
    const enviouMidia = !!(body.image || body.video || body.document || body.audio || body.type === "image");

    if (!texto && !enviouMidia) {
      return res.sendStatus(200);
    }

    // --- FIX DE TIMEZONE ---
    const hora = Number(
      new Date().toLocaleString("en-US", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        hour12: false
      })
    );

    if (hora >= 22 || hora < 6) {
      console.log("HORÁRIO DE DESCANSO EN BRASIL");
      return res.sendStatus(200);
    }

    // Comprobación de pausa humana activa
    if (pausaHumana[phone] && Date.now() < pausaHumana[phone]) {
      console.log("BOT EN PAUSA HUMANA:", phone);
      return res.sendStatus(200);
    }

    console.log(`MENSAGEM RECIBIDA DE ${phone}:`, texto);

    const textoLimpo = texto.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");

    // Forzar atención humana manual
    if (
      textoLimpo.includes("yordanys") ||
      textoLimpo.includes("humano")   ||
      textoLimpo.includes("operador")
    ) {
      pausaHumana[phone] = Date.now() + PAUSA_HUMANA_MS;
      await enviarMensaje(phone, "Claro 👌 Yordanys te atenderá en breve.");
      return res.sendStatus(200);
    }

    // --- EVALUACIÓN COMERCIAL ---
    const esComercial = GATILHOS.some(g => contemPalavra(textoLimpo, g));

    if (esComercial) {
      conversaAtiva[phone] = Date.now() + CONVERSA_ATIVA_MS;
    } else if (conversaAtiva[phone] && Date.now() > conversaAtiva[phone]) {
      delete conversaAtiva[phone];
      resetEstado(phone);
    }

    const conversaEmAndamento = conversaAtiva[phone] && Date.now() < conversaAtiva[phone];

    // Control de Saludos espontáneos
    const esSaudacao = SAUDACOES.some(s => contemPalavra(textoLimpo, s));
    if (esSaudacao && !esComercial && !conversaEmAndamento) {
      await enviarMensaje(phone, saudacaoPorHora(hora));
      return res.sendStatus(200);
    }

    if (!esComercial && !conversaEmAndamento) {
      return res.sendStatus(200);
    }

    // Instanciar / Recuperar Estado
    let estado = getEstado(phone);

    // Cambiar de operación dinámicamente si se detecta una nueva intención clara
    const novaOperacao = detectarOperacion(textoLimpo);
    if (novaOperacao && novaOperacao !== estado.operacion) {
      resetEstado(phone);
      estadoCliente[phone].operacion = novaOperacao;
      estado = estadoCliente[phone];
    }

    // Extracción analítica de datos
    detectarMoeda(textoLimpo, estado);
    detectarMonto(texto, textoLimpo, estado);
    detectarTarjeta(texto, estado);
    detectarMunicipio(textoLimpo, estado);
    detectarNumeroRecarga(texto, estado);

    // Captura y procesamiento del comprobante PIX
    if (
      estado.aguardando === "comprovante" &&
      estado.pixEnviado &&
      (
        enviouMidia ||
        contemPalavra(textoLimpo, "pix") ||
        contemPalavra(textoLimpo, "enviado") ||
        contemPalavra(textoLimpo, "comprovante")
      )
    ) {
      await enviarMensaje(phone, "Comprovante recebido 👌");
      await enviarMensaje(phone, "Sua operação será processada em breve.");
      resetEstado(phone);
      delete conversaAtiva[phone];
      return res.sendStatus(200);
    }

    // --- EJECUCIÓN CONTROLADA DE FLUJOS ---
    if (estado.operacion === "transferencia") {
      if (await procesarTransferencia(phone, estado)) return res.sendStatus(200);
    }
    if (estado.operacion === "entrega") {
      if (await procesarEntrega(phone, estado)) return res.sendStatus(200);
    }
    if (estado.operacion === "recarga") {
      if (await procesarRecarga(phone, estado)) return res.sendStatus(200);
    }

    // 4 — OPENAI COST BUG PROTECTION (Evita quemar presupuesto innecesario si el flujo concluyó)
    if (estado.operacion && estado.pixEnviado) {
      console.log(`[COST CONTROL] Flujo estructurado terminado para ${phone}. Evitando llamada a OpenAI.`);
      return res.sendStatus(200);
    }

    // OpenAI Fallback Seguro
    const respostaIA = await responderIA(texto, estado);
    await enviarMensaje(phone, respostaIA);
    return res.sendStatus(200);

  } catch (error) {
    console.log("ERRO GERAL WEBHOOK:", error.message);
    if (!res.headersSent) {
      return res.sendStatus(500);
    }
  } finally {
    delete locks[phone];
  }
});

/* =========================
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.send("YordaBot ONLINE");
});

/* =========================
   START
========================= */

app.listen(PORT, () => {
  console.log(`Servidor de alta fidelidad corriendo en puerto ${PORT}`);
});
