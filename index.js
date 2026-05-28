const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();

// ==========================================
// CONFIGURACIONES INICIALES
// ==========================================
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const TASAS_PATH = path.join(__dirname, "src", "config", "tasas.json");

// ==========================================
// 4. PROTECCIÓN DEL DASHBOARD (Middleware)
// ==========================================
app.use("/dashboard", (req, res, next) => {
    const token = req.query.token;
    const secret = (process.env.ADMIN_TOKEN || "yorda123").trim();

    if (!token || token.trim() !== secret) {
        return res.status(401).send(`
            <div style="font-family:sans-serif; text-align:center; padding-top:50px;">
                <h1>🔒 Acceso Denegado</h1>
                <p>El token proporcionado es inválido o no existe.</p>
                <small style="color:#666">YordaBot Admin Security</small>
            </div>
        `);
    }
    next();
});

// ==========================================
// ROTAS DE NAVEGACIÓN
// ==========================================
app.get("/", (req, res) => res.send("YordaBot Online"));

app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// ==========================================
// API ADMINISTRATIVA
// ==========================================

// 3. STATS REALES
app.get("/admin/stats", async (req, res) => {
    try {
        let stats = { clientes: 0, vip: 0, operaciones: 0, total: 0 };
        
        try {
            const { obtenerTodos } = require("./src/services/customer-memory");
            const clientes = obtenerTodos();
            
            // Si es un Map o un Array de entradas
            const entries = clientes instanceof Map ? clientes.entries() : Object.entries(clientes);

            for (const [phone, data] of entries) {
                stats.clientes++;
                stats.operaciones += (data.totalOperaciones || 0);
                stats.total += (data.totalEnviado || 0);
                if (data.vip) stats.vip++;
            }
        } catch (err) {
            console.log("⚠️ Nota: Conectando con stats base...");
        }
        
        return res.json(stats);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// 2. GET TASAS (CACHE ZERO)
app.get("/admin/tasas", (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
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

// 1. POST (VALIDACIÓN DE DATOS)
app.post("/admin/tasas", (req, res) => {
    try {
        const { brl_0, brl_100, brl_500, brl_1000, usd1, usd2 } = req.body;

        const valores = [brl_0, brl_100, brl_500, brl_1000, usd1, usd2];
        if (valores.some(v => v === null || v === undefined || isNaN(Number(v)))) {
            return res.status(400).json({
                success: false,
                error: "Datos inválidos: Revisa los números."
            });
        }

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

        const dir = path.dirname(TASAS_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(TASAS_PATH, JSON.stringify(nuevasTasas, null, 2));
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// INICIALIZACIÓN
// ==========================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ SERVER UP > Puerto ${PORT}`);
});
