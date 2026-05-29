const fs = require("fs");
const path = require("path");

const DB = path.join(
  __dirname,
  "../data/operations.json"
);

let operaciones = [];

try {

  if (fs.existsSync(DB)) {

    operaciones = JSON.parse(
      fs.readFileSync(DB, "utf8")
    );

  }

} catch (e) {

  operaciones = [];

}

function guardar() {

  fs.writeFileSync(
    DB,
    JSON.stringify(
      operaciones,
      null,
      2
    )
  );

}

function agregarOperacion(data) {

  operaciones.unshift({

    id: Date.now(),

    fecha:
      new Date().toISOString(),

    ...data

  });

  guardar();

}

function obtenerTodas() {

  return operaciones;

}

module.exports = {

  agregarOperacion,

  obtenerTodas

};
