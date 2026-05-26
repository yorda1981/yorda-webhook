function calcularOperacion(
  valor
) {

  valor =
    Number(valor);

  if (
    isNaN(valor) ||
    valor <= 0
  ) {

    return null;
  }

  // =====================
  // TASAS
  // =====================
  let tasa = 100;

  if (valor >= 100) {

    tasa = 120;
  }

  if (valor >= 500) {

    tasa = 122;
  }

  // =====================
  // CALCULO
  // =====================
  const cup =
    valor * tasa;

  // =====================
  // UPSELL
  // =====================
  let upsell = null;

  if (valor < 100) {

    const diferencia =
      100 - valor;

    const cupMejorado =
      100 * 120;

    upsell = {

      falta:
        diferencia,

      nuevaTasa:
        120,

      nuevoTotal:
        cupMejorado
    };
  }

  return {

    valor,
    tasa,
    cup,
    upsell
  };
}

module.exports = {
  calcularOperacion
};
