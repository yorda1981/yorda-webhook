const axios = require("axios");

const {
  ZAPI_INSTANCE,
  ZAPI_TOKEN,
  ZAPI_CLIENT_TOKEN
} = require("../config/env");

const logger = require("../utils/logger");

async function enviarMensaje(phone, message) {
  try {
    await axios({
      method: "post",
      url: `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
      headers: {
        "Client-Token": ZAPI_CLIENT_TOKEN,
        "Content-Type": "application/json"
      },
      data: {
        phone,
        message: String(message).replace(/\*/g, "").trim(),
        checkContact: false
      },
      timeout: 15000
    });
  } catch (e) {
    logger("error", "ZAPI_SEND_ERROR", { err: e.message });
  }
}

async function enviarImagen(phone, imageUrl, caption = "") {
  try {
    await axios({
      method: "post",
      url: `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-image`,
      headers: {
        "Client-Token": ZAPI_CLIENT_TOKEN,
        "Content-Type": "application/json"
      },
      data: {
        phone,
        image: imageUrl,
        caption
      },
      timeout: 15000
    });
  } catch (e) {
    logger("error", "ZAPI_IMAGE_ERROR", { err: e.message });
  }
}

// ─────────────────────────────────────────
// TYPING INDICATOR
// Muestra "escribiendo..." en WhatsApp antes
// de enviar el mensaje. Calcula el delay según
// el largo del texto (simula velocidad humana).
// ─────────────────────────────────────────

const CHARS_POR_SEGUNDO = 18;   // ~velocidad de tipeo humano normal
const DELAY_MIN_MS      = 800;  // mínimo para que se note
const DELAY_MAX_MS      = 4500; // máximo para no hacer esperar demasiado

function calcularDelay(texto) {
    if (!texto) return DELAY_MIN_MS;
    const ms = (texto.length / CHARS_POR_SEGUNDO) * 1000;
    return Math.min(Math.max(ms, DELAY_MIN_MS), DELAY_MAX_MS);
}

async function mostrarEscribiendo(phone, duracionMs) {
    try {
        await axios({
            method: "post",
            url: `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/typing`,
            headers: {
                "Client-Token": ZAPI_CLIENT_TOKEN,
                "Content-Type": "application/json"
            },
            data: { phone, duration: Math.round(duracionMs / 1000) },
            timeout: 5000
        });
        await new Promise(r => setTimeout(r, duracionMs));
    } catch {
        // Si falla el typing, continuar igual — no bloquear el mensaje
        await new Promise(r => setTimeout(r, Math.min(duracionMs, 1500)));
    }
}

// enviarConDelay — reemplaza enviarSeguro en openai.js
// Muestra typing, espera, luego envía.
async function enviarConDelay(phone, message, delayOverrideMs = null) {
    if (!phone || !message) return;
    const delay = delayOverrideMs ?? calcularDelay(String(message));
    await mostrarEscribiendo(phone, delay);
    await enviarMensaje(phone, message);
}

module.exports = {
    enviarMensaje,
    enviarImagen,
    enviarConDelay,
    mostrarEscribiendo,
    calcularDelay
};
