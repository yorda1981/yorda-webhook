function detectarIntencion(
  text
) {

  const lower =
    String(text || "")
    .toLowerCase()
    .trim();

  // =====================
  // VACÍO
  // =====================
  if (!lower) {

    return false;
  }

  // =====================
  // IGNORAR LINKS
  // =====================
  if (

    lower.includes("http://")

    ||

    lower.includes("https://")

  ) {

    return false;
  }

  // =====================
  // IGNORAR NOTICIAS
  // =====================
  const noticias = [

    "folha",
    "g1",
    "uol",
    "cnn",
    "pf",
    "governador",
    "política",
    "politica",
    "master",
    "busca e apreensão"
  ];

  if (

    noticias.some(

      n =>
        lower.includes(n)
    )

  ) {

    return false;
  }

  // =====================
  // IGNORAR MÉDICO
  // =====================
  const medico = [

    "ultra-som",
    "ultrassom",
    "abdômen",
    "abdomen",
    "receita",
    "consulta",
    "doutor",
    "exame"
  ];

  if (

    medico.some(

      m =>
        lower.includes(m)
    )

  ) {

    return false;
  }

  // =====================
  // PALABRAS NEGOCIO
  // =====================
  const keywords = [

    "real",
    "reales",
    "r$",

    "cup",
    "usd",
    "mlc",

    "dolar",
    "dólar",

    "pix",

    "remesa",
    "transferencia",
    "transferência",
    "enviar",

    "saldo",
    "recarga",

    "clasica",
    "clásica",
    "prepago",

    "efectivo",

    "tasa",
    "cambio",

    "tarjeta",
    "cartão",
    "cartao"
  ];

  // =====================
  // KEYWORDS
  // =====================
  const tieneKeyword =
    keywords.some(

      k =>
        lower.includes(k)
    );

  // =====================
  // NÚMEROS
  // =====================
  const tieneNumero =
    /\d+/.test(lower);

  // =====================
  // REGLA FINAL
  // =====================
  if (

    tieneKeyword ||

    (
      tieneNumero &&

      (
        lower.includes("real")
        ||

        lower.includes("r$")
        ||

        lower.includes("usd")
        ||

        lower.includes("cup")
      )
    )

  ) {

    return true;
  }

  return false;
}

module.exports = {
  detectarIntencion
};
