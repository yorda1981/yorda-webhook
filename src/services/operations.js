const fs = require("fs");
const path = require("path");

const DB = path.join(__dirname, "../data/operations.json");

let operaciones = [];

// =====================
// CARGAR AL INICIO
// =====================
try {
  if (fs.existsSync(DB)) {
    const raw = fs.readFileSync(DB, "utf8");
    operaciones = raw ? JSON.parse(raw) : [];
  }
} catch (e) {
    console.error("❌ Error cargando operaciones:", e.message);
    operaciones = [];
}

// =====================
// GUARDAR EN DISCO
// =====================
function guardar() {
  try {
    fs.writeFileSync(DB, JSON.stringify(operaciones, null, 2));
  } catch (e) {
    console.error("❌ Error guardando operaciones:", e.message);
  }
}

// ==========================================
// FASE 1 & 2: AGREGAR (Blindaje de Status)
// ==========================================
function agregarOperacion(data) {
  const nueva = {
    id: Date.now(),
    fecha: new Date().toISOString(),
    phone: data.phone || "Sin teléfono",
    nombre: data.nombre || "Cliente",
    monto: Number(data.monto || 0),
    tipo: data.tipo || "brl_cup",
    ...data,
    status: "pendiente" // 🛡️ Al ir al final, sobreescribe cualquier intento externo
  };

  operaciones.unshift(nueva);
  guardar();
  console.log(`⏳ Operación PENDIENTE: R$${nueva.monto} - ${nueva.nombre}`);
  return nueva;
}

// =====================
// FASE 3: CONFIRMAR
// =====================
function confirmarOperacion(id) {
    const op = operaciones.find(o => o.id == id);

    if (!op) {
        console.log(`❌ ID no encontrado: ${id}`);
        return false;
    }

    if (op.status === "confirmada") return true;

    op.status = "confirmada";
    op.fechaConfirmacion = new Date().toISOString();
    
    guardar();
    console.log(`✅ Operación CONFIRMADA: ID ${id}`);
    return true;
}

// =====================
// FASE 4: OBTENER TODAS
// =====================
function obtenerTodas() {
  return operaciones;
}

// =====================
// ESTADÍSTICAS REALES
// =====================
function obtenerEstadisticas() {
    // Solo operaciones que pasaron por tu verificación manual
    const confirmadas = operaciones.filter(op => op.status === "confirmada");
    
    const volumenTotal = confirmadas.reduce((acc, op) => acc + (Number(op.monto) || 0), 0);
    
    return {
        totalOperaciones: confirmadas.length,
        volumenTotal: volumenTotal,
        pendientes: operaciones.filter(op => op.status === "pendiente").length
    };
}

module.exports = {
  agregarOperacion,
  confirmarOperacion,
  obtenerTodas,
  obtenerEstadisticas
};
