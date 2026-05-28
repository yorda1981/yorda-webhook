const fs = require("fs");
const path = require("path");

// =====================
// RUTA DB
// =====================

const DB_PATH = path.join(
  __dirname,
  "../data/customers.json"
);

// =====================
// MEMORIA EN RAM
// =====================

let clientes = new Map();

// =====================
// CREAR ARCHIVO SI NO EXISTE
// =====================

function asegurarDB() {

  try {

    if (!fs.existsSync(DB_PATH)) {

      fs.writeFileSync(
        DB_PATH,
        JSON.stringify({}, null, 2)
      );

      console.log(
        "📁 customers.json creado"
      );
    }

  } catch (err) {

    console.error(
      "❌ Error creando DB",
      err
    );
  }
}

// =====================
// CARGAR CLIENTES
// =====================

function cargarClientes() {

  try {

    asegurarDB();

    const raw = fs.readFileSync(
      DB_PATH,
      "utf8"
    );

    if (!raw || raw.trim() === "") {

      clientes = new Map();

      console.log(
        "📂 DB vacía iniciada"
      );

      return;
    }

    const data = JSON.parse(raw);

    clientes = new Map(
      Object.entries(data)
    );

    console.log(
      `✅ Clientes cargados: ${clientes.size}`
    );

  } catch (err) {

    console.error(
      "❌ Error cargando clientes",
      err
    );

    clientes = new Map();
  }
}

// =====================
// GUARDAR DB
// =====================

function guardarDB() {

  try {

    const obj =
      Object.fromEntries(clientes);

    fs.writeFileSync(
      DB_PATH,
      JSON.stringify(obj, null, 2)
    );

    console.log(
      "💾 DB guardada correctamente"
    );

  } catch (err) {

    console.error(
      "❌ Error guardando DB",
      err
    );
  }
}

// =====================
// GUARDAR CLIENTE
// =====================

function guardarCliente({

  phone,

  nombre = "",

  monto = 0,

  tipo = "brl_cup",

  banco = "",

  tarjeta = ""

}) {

  try {

    if (!phone) {

      console.log(
        "🚫 Phone inválido"
      );

      return null;
    }

    const actual =

      clientes.get(phone)

      ||

      {

        nombre: "",

        totalOperaciones: 0,

        totalEnviado: 0,

        ultimoMonto: 0,

        tipoFavorito: tipo,

        bancoFavorito: "",

        tarjetaFrecuente: "",

        ultimaOperacion: null,

        vip: false,

        createdAt:
          new Date().toISOString()
      };

    // =====================
    // ACTUALIZAR DATOS
    // =====================

    actual.nombre =
      nombre || actual.nombre;

    // SOLO SUMAR SI HAY MONTO

    if (Number(monto) > 0) {

      actual.totalOperaciones += 1;

      actual.totalEnviado +=
        Number(monto || 0);

      actual.ultimoMonto =
        Number(monto || 0);

      actual.tipoFavorito =
        tipo || actual.tipoFavorito;
    }

    actual.bancoFavorito =
      banco || actual.bancoFavorito;

    actual.tarjetaFrecuente =
      tarjeta || actual.tarjetaFrecuente;

    actual.ultimaOperacion =
      new Date().toISOString();

    actual.updatedAt =
      new Date().toISOString();

    // =====================
    // VIP
    // =====================

    actual.vip = (

      actual.totalEnviado >= 1000 ||

      actual.totalOperaciones >= 10

    );

    clientes.set(
      phone,
      actual
    );

    guardarDB();

    console.log(
      `👤 Cliente actualizado: ${phone}`
    );

    return actual;

  } catch (err) {

    console.error(
      "❌ Error guardando cliente",
      err
    );

    return null;
  }
}

// =====================
// OBTENER CLIENTE
// =====================

function obtenerCliente(
  phone
) {

  return (
    clientes.get(phone)
    || null
  );
}

// =====================
// OBTENER TODOS
// =====================

function obtenerTodos() {

  return Array.from(
    clientes.entries()
  ).map(([phone, data]) => ({
    phone,
    ...data
  }));
}

// =====================
// ELIMINAR CLIENTE
// =====================

function eliminarCliente(
  phone
) {

  clientes.delete(phone);

  guardarDB();

  console.log(
    `🗑️ Cliente eliminado: ${phone}`
  );
}

// =====================
// CARGAR AL INICIAR
// =====================

cargarClientes();

// =====================
// EXPORTS
// =====================

module.exports = {

  guardarCliente,

  obtenerCliente,

  obtenerTodos,

  eliminarCliente
};
