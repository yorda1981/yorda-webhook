const fs =
require("fs");

const path =
require("path");

// =====================
// LEER TASAS EN VIVO
// =====================
function obtenerTasas() {

const filePath =

path.join(

  __dirname,

  "../config/tasas.json"
);

const data =

fs.readFileSync(
  filePath,
  "utf8"
);

return JSON.parse(data);
}

// =====================
// OBTENER TASA BRL
// =====================
function obtenerTasaBRL(
valor
) {

const tasas =
obtenerTasas();

const faixa =
tasas.brl_cup.faixas.find(

  f =>

    valor >= f.min &&

    valor <= f.max
);

return faixa
? faixa.tasa
: 100;
}

// =====================
// CALCULAR
// =====================
function calcularOperacion({

tipo,
valor,
municipio
}) {

const tasas =
obtenerTasas();

// =====================
// BRL → CUP
// =====================
if (
tipo ===
"brl_cup"
) {

const tasa =
  obtenerTasaBRL(
    valor
  );

const cup =
  valor * tasa;

let upsell =
  null;

// =====================
// UPSELL
// =====================
const siguienteFaixa =
  tasas.brl_cup.faixas.find(

    f =>
      valor < f.min
  );

if (siguienteFaixa) {

  const falta =
    siguienteFaixa.min -
    valor;

  upsell = {

    falta,

    nuevoTotal:

      siguienteFaixa.min *

      siguienteFaixa.tasa
  };
}

return {

  tipo,

  valor,

  tasa,

  cup,

  upsell
};

}

// =====================
// USD CLÁSICA
// =====================
if (
tipo ===
"usd_clasica"
) {

const tasa =
  tasas.usd_clasica.tasa;

return {

  tipo,

  usd:
    valor,

  tasa,

  reales:

    (
      valor * tasa
    ).toFixed(2)
};

}

// =====================
// USD PREPAGO
// =====================
if (
tipo ===
"usd_prepago"
) {

const tasa =
  tasas.usd_prepago.tasa;

return {

  tipo,

  usd:
    valor,

  tasa,

  reales:

    (
      valor * tasa
    ).toFixed(2)
};

}

// =====================
// RECARGA
// =====================
if (
tipo ===
"saldo_cup"
) {

const tasa =
  tasas.saldo_cup.tasa;

return {

  tipo,

  reales:
    valor,

  cup:
    valor * tasa
};

}

// =====================
// EFECTIVO HABANA
// =====================
if (
tipo ===
"efectivo_habana"
) {

const tasa =
  obtenerTasaBRL(
    valor
  );

const entrega =
  tasas
  .efectivo_habana
  .municipios[
    municipio
  ] || 0;

return {

  tipo,

  valor,

  municipio,

  entrega,

  tasa,

  cup:
    valor * tasa
};

}

return null;
}

module.exports = {
calcularOperacion
};
