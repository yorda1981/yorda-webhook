const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());

// --- CONFIGURACIÓN DE VARIABLES ---
const ZAPI_URL = process.env.ZAPI_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1aNCBl-vEgOOfuA8o0EetDJoOaaAPxffkfePc4Rg0wXQ';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Ruta de salud para que Railway no desconecte el bot
app.get('/', (req, res) => {
    res.send('🚀 YordaBot está vivo y operando ✅');
});

// Configuración de Google Sheets con manejo de error de JSON
let sheets;
try {
    const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheets = google.sheets({ version: 'v4', auth });
} catch (error) {
    console.error('❌ Error crítico en el JSON de Google:', error.message);
}

// --- LÓGICA DEL AGENTE v2.6 ---
async function procesarAgente(input) {
    const { phone, texto, estado, history, media } = input;
    const TASA_CUP = 115;
    
    const VALID_STEPS = {
        "inicio": ["esperando_monto"],
        "esperando_monto": ["esperando_numero", "esperando_monto"],
        "esperando_numero": ["esperando_comprobante", "esperando_numero"],
        "esperando_comprobante": ["completado", "esperando_comprobante"],
        "completado": ["inicio"]
    };

    if (estado.etapa === "esperando_comprobante" && media) {
        estado.etapa = "completado";
    }

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: `Eres YordaBot, gestor de remesas. Tasa: 1 BRL = ${TASA_CUP} CUP. Estado actual: ${JSON.stringify(estado)}. Responde siempre en JSON con: {"reply": "texto", "intent": "remesa|otro", "confidence": 0.9, "extracted": {"monto": "100", "numero": "string"}}` },
                ...history,
                { role: "user", content: texto }
            ],
            response_format: { type: "json_object" },
            temperature: 0.1
        });

        const res = JSON.parse(response.choices[0].message.content);
        let nextState = { ...estado };
        
        if (res.extracted?.monto && VALID_STEPS[estado.etapa]?.includes("esperando_numero")) {
            nextState.monto = res.extracted.monto;
            nextState.etapa = "esperando_numero";
        }
        if (res.extracted?.numero && VALID_STEPS[estado.etapa]?.includes("esperando_comprobante")) {
            nextState.numero = res.extracted.numero;
            nextState.etapa = "esperando_comprobante";
        }

        return { reply: res.reply, state: nextState, handoff: res.confidence < 0.5 };
    } catch (e) {
        return { reply: "Lo siento, ¿puedes repetir eso? 👌", state: estado };
    }
}

// --- WEBHOOK PRINCIPAL ---
app.post('/webhook', async (req, res) => {
    // Railway/Z-API a veces manda pings de prueba, respondemos 200 rápido
    res.sendStatus(200); 

    const { phone, text, isMedia } = req.body;
    if (!phone || !text) return;

    try {
        // 1. Leer de Google Sheets
        const data = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Hoja 1!A:H' });
        const rows = data.data.values || [];
        const rowIndex = rows.findIndex(r => r[0] === String(phone));
        
        let estado = rowIndex !== -1 ? { 
            phone: rows[rowIndex][0], 
            etapa: rows[rowIndex][1],
            monto: rows[rowIndex][2],
            numero: rows[rowIndex][4]
        } : { etapa: 'inicio' };

        // 2. Procesar respuesta
        const result = await procesarAgente({ phone, texto: text, estado, history: [], media: isMedia });

        // 3. Actualizar Google Sheets
        const rowValue = [String(phone), result.state.etapa, result.state.monto || '', '', result.state.numero || '', 'es', Date.now(), 'false'];
        
        if (rowIndex === -1) {
            await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID, range: 'Hoja 1!A:H',
                valueInputOption: 'USER_ENTERED', resource: { values: [rowValue] }
            });
        } else {
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID, range: `Hoja 1!A${rowIndex + 1}`,
                valueInputOption: 'USER_ENTERED', resource: { values: [rowValue] }
            });
        }

        // 4. Enviar a WhatsApp vía Z-API
        await axios.post(ZAPI_URL, { phone, text: result.reply });

    } catch (error) {
        console.error('❌ Error procesando mensaje:', error.message);
    }
});

// --- INICIO DEL SERVIDOR (Configuración para Railway) ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 YordaBot activo en puerto ${PORT}`);
});
