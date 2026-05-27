const clientes =
  new Map();

// =====================
// GUARDAR CLIENTE
// =====================
function guardarCliente({
  phone,
  monto = 0,
  tipo = "brl_cup"
}) {

  const actual =
    clientes.get(phone) || {

      totalOperaciones: 0,

      totalEnviado: 0,

      ultimoMonto: 0,

      tipoFavorito:
        tipo,

      ultimaOperacion:
        null
    };

  actual.totalOperaciones += 1;

  actual.totalEnviado +=
    Number(monto || 0);

  actual.ultimoMonto =
    Number(monto || 0);

  actual.tipoFavorito =
    tipo;

  actual.ultimaOperacion =
    new Date()
    .toISOString();

  clientes.set(
    phone,
    actual
  );

  return actual;
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

module.exports = {

  guardarCliente,

  obtenerCliente
};
