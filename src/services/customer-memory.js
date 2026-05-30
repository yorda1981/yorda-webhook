const fs = require("fs");
const path = require("path");

console.log("🔥 customer-memory cargado (Versión Actualizada)");

const DB_PATH = path.join(__dirname, "../data/customers.json");

let clientes = new Map();

function asegurarDB() {
    try {
        if (!fs.existsSync(DB_PATH)) {
            fs.writeFileSync(DB_PATH, JSON.stringify({}, null, 2));
            console.log("📁 customers.json creado");
        }
    } catch (err) {
        console.error("❌ Error creando DB", err);
    }
}

function cargarClientes() {
    try {
        asegurarDB();
        const raw = fs.readFileSync(DB_PATH, "utf8");
        if (!raw || raw.trim() === "") {
            clientes = new Map();
            return;
        }
        const data = JSON.parse(raw);
        clientes = new Map(Object.entries(data));
        console.log(`✅ Memoria de clientes lista: ${clientes.size}`);
    } catch (err) {
        console.error("❌ Error cargando clientes", err);
        clientes = new Map();
    }
}

function guardarDB() {
    try {
        const obj = Object.fromEntries(clientes);
        fs.writeFileSync(DB_PATH, JSON.stringify(obj, null, 2));
    } catch (err) {
        console.error("❌ Error guardando DB", err);
    }
}

function guardarCliente({
    phone,
    nombre = "",
    monto = 0,
    tipo = "brl_cup",
    banco = "",
    tarjeta = "",
    estado = null,
    fechaEstado = null
}) {
    try {
        if (!phone) return null;

        const actual = clientes.get(phone) || {
            nombre: "",
            ultimoMonto: 0,
            tipoFavorito: tipo,
            bancoFavorito: "",
            tarjetaFrecuente: "",
            ultimaConsulta: null,
            estado: null,
            fechaEstado: null,
            vip: false, // Ahora el VIP se gestionará por operaciones reales
            createdAt: new Date().toISOString()
        };

        // ACTUALIZACIÓN DE MEMORIA (No suma estadísticas)
        actual.nombre = nombre || actual.nombre;
        
        if (Number(monto) > 0) {
            actual.ultimoMonto = Number(monto);
            actual.tipoFavorito = tipo || actual.tipoFavorito;
        }

        actual.bancoFavorito = banco || actual.bancoFavorito;
        actual.tarjetaFrecuente = tarjeta || actual.tarjetaFrecuente;

        // Actualización de estado (Paso 1)
        if (estado !== null) {
            actual.estado = estado;
        }

        if (fechaEstado !== null) {
            actual.fechaEstado = fechaEstado;
        }

        actual.ultimaConsulta = new Date().toISOString();
        actual.updatedAt = new Date().toISOString();

        clientes.set(phone, actual);
        guardarDB();
        return actual;
    } catch (err) {
        console.error("❌ Error guardando memoria de cliente", err);
        return null;
    }
}

function obtenerCliente(phone) {
    return clientes.get(phone) || null;
}

function obtenerTodos() {
    return Array.from(clientes.entries()).map(([phone, data]) => ({
        phone,
        ...data
    }));
}

function eliminarCliente(phone) {
    clientes.delete(phone);
    guardarDB();
}

cargarClientes();

module.exports = {
    guardarCliente,
    obtenerCliente,
    obtenerTodos,
    eliminarCliente
};
