```js id="q7n2m5"
const fs =
  require("fs");

const path =
  require("path");

const TASAS_PATH =
  path.join(
    __dirname,
    "../config/tasas.json"
  );

function leerTasas(){

  const raw =
    fs.readFileSync(
      TASAS_PATH,
      "utf8"
    );

  return JSON.parse(raw);
}

function calcularOperacion({
  tipo,
  valor
}){

  const tasas =
    leerTasas();

  // =====================
  // BRL → CUP
  // =====================

  if(tipo === "brl_cup"){

    const faixa =
      tasas.brl_cup.faixas.find(

        f =>

          valor >= f.min &&

          valor <= f.max
      );

    if(!faixa){

      throw new Error(
        "FAIXA_NOT_FOUND"
      );
    }

    const cup =
      Math.floor(
        valor * faixa.tasa
      );

    return {

      valor,

      tasa:
        faixa.tasa,

      cup
    };
  }

  // =====================
  // USD CLÁSICA
  // =====================

  if(tipo === "usd_clasica"){

    return {

      valor,

      tasa:
        tasas.usd_clasica.tasa,

      cup:
        valor *
        tasas.usd_clasica.tasa
    };
  }

  // =====================
  // USD PREPAGO
  // =====================

  if(tipo === "usd_prepago"){

    return {

      valor,

      tasa:
        tasas.usd_prepago.tasa,

      cup:
        valor *
        tasas.usd_prepago.tasa
    };
  }

  return null;
}

module.exports = {
  calcularOperacion
};
```
