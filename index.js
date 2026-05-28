const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();

// ==========================================
// CONFIGURAÇÕES INICIAIS
// ==========================================
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Caminho para o ficheiro de configuração das taxas
const TASAS_PATH = path.join(__dirname, "src", "config", "tasas.json");

// ==========================================
// ROTAS DE NAVEGAÇÃO
// ==========================================

// Serve o Dashboard na raiz ou em /dashboard
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// ==========================================
// API ADMINISTRATIVA (Sincronizada com o Painel)
// ==========================================

// 1. Obter Estatísticas (Clientes, VIP, Operações, Volume)
app.get("/admin/stats", async (req, res) => {
    try {
        // Aqui deves importar o teu serviço de memória/base de dados
        // Exemplo genérico:
        const stats = {
            clientes: 124, 
            vip: 12, 
            operaciones: 450, 
            total: 85600.50 // Valor em BRL
        };
        return res.json(stats);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// 2. Obter as 4 escalas de BRL e os 2 USD
app.get("/admin/tasas", (req, res) => {
    try {
        if (!fs.existsSync(TASAS_PATH)) {
            return res.json({ brl_0: 0, brl_100: 0, brl_500: 0, brl_1000: 0, usd1: 0, usd2: 0 });
        }
        const data = fs.readFileSync(TASAS_PATH, "utf8");
        const json = JSON.parse(data);
        
        return res.json({
            brl_0:    json.brl_cup?.faixas[0]?.tasa || 0,
            brl_100:  json.brl_cup?.faixas[1]?.tasa || 0,
            brl_500:  json.brl_cup?.faixas[2]?.tasa || 0,
            brl_1000: json.brl_cup?.faixas[3]?.tasa || 0,
            usd1:     json.usd_clasica?.tasa || 0,
            usd2:     json.usd_prepago?.tasa || 0
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// 3. Guardar as taxas enviadas pelo Dashboard
app.post("/admin/tasas", (req, res) => {
    try {
        const { brl_0, brl_100, brl_500, brl_1000, usd1, usd2 } = req.body;
        
        const nuevasTasas = {
            brl_cup: {
                faixas: [
                    { min: 0,    max: 99,     tasa: Number(brl_0) },
                    { min: 100,  max: 499,    tasa: Number(brl_100) },
                    { min: 500,  max: 999,    tasa: Number(brl_500) },
                    { min: 1000, max: 999999, tasa: Number(brl_1000) }
                ]
            },
            usd_clasica: { tasa: Number(usd1) },
            usd_prepago: { tasa: Number(usd2) }
        };

        // Criar pasta se não existir
        const dir = path.dirname(TASAS_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(TASAS_PATH, JSON.stringify(nuevasTasas, null, 2));
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// WEBHOOK WHATSAPP (Exemplo de Integração)
// ==========================================
app.post("/webhook", async (req, res) => {
    // A tua lógica de receção de mensagens do WhatsApp aqui
    console.log("Mensagem recebida:", req.body);
    res.sendStatus(200);
});

// ==========================================
// INICIALIZAÇÃO DO SERVIDOR
// ==========================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`
    ✅ YORDA-BOT SERVER ONLINE
    🚀 Porto: ${PORT}
    🔥 Dashboard configurado com 4 faixas BRL
    `);
});
