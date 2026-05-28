```js id="q5n7m2"
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

    clientes.get(phone)

    ||

    {

      totalOperaciones: 0,

      totalEnviado: 0,

      ultimoMonto: 0,

      tipoFavorito:
        tipo,

      ultimaOperacion:
        null,

      vip: false
    };

  actual.totalOperaciones += 1;

  actual.totalEnviado +=

    Number(
      monto || 0
    );

  actual.ultimoMonto =

    Number(
      monto || 0
    );

  actual.tipoFavorito =
    tipo;

  actual.ultimaOperacion =

    new Date()
    .toISOString();

  // =====================
  // VIP
  // =====================

  actual.vip =

    actual.totalEnviado >= 1000;

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

// =====================
// OBTENER TODOS
// =====================
function obtenerTodos(){

  return clientes;
}

module.exports = {

  guardarCliente,

  obtenerCliente,

  obtenerTodos
};
```
