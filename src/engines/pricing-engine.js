function calcularOperacion({
  tipo,
  valor,
  municipio = null
}) {

  valor =
    Number(valor);

  if (
    isNaN(valor) ||
    valor <= 0
  ) {

    return null;
  }

  // =====================
  // BRL → CUP
  // =====================
  if (
    tipo === "brl_cup"
  ) {

    let tasa = 100;

    if (valor >= 100) {

      tasa = 120;
    }

    if (valor >= 500) {

      tasa = 122;
    }

    const cup =
      valor * tasa;

    let upsell = null;

    if (valor < 100) {

      upsell = {

        falta:
          100 - valor,

        nuevaTasa:
          120,

        nuevoTotal:
          100 * 120
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
    tipo === "usd_clasica"
  ) {

    const tasa =
      5.60;

    const total =
      valor / tasa;

    return {

      tipo,

      reales:
        valor,

      usd:
        total.toFixed(2),

      tasa
    };
  }

  // =====================
  // USD PREPAGO
  // =====================
  if (
    tipo === "usd_prepago"
  ) {

    const tasa =
      5.60;

    const total =
      valor / tasa;

    return {

      tipo,

      reales:
        valor,

      usd:
        total.toFixed(2),

      tasa
    };
  }

  // =====================
  // RECARGA SALDO
  // =====================
  if (
    tipo === "saldo_cup"
  ) {

    const cup =
      valor * 20;

    return {

      tipo,

      reales:
        valor,

      cup,

      vigencia:
        365
    };
  }

  // =====================
  // EFECTIVO HABANA
  // =====================
  if (
    tipo === "efectivo_habana"
  ) {

    const tasa =
      102;

    const cup =
      valor * tasa;

    let entrega =
      110;

    const municipios60 = [

      "habana vieja",
      "centro habana",
      "plaza",
      "cerro",
      "diez de octubre"
    ];

    if (

      municipio &&

      municipios60.includes(
        municipio.toLowerCase()
      )

    ) {

      entrega = 60;
    }

    return {

      tipo,

      valor,
      tasa,
      cup,
      entrega,
      municipio
    };
  }

  return null;
}

module.exports = {
  calcularOperacion
};
