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
  // LINKS
  // =====================
  if (

    lower.includes("http://")

    ||

    lower.includes("https://")

  ) {

    return false;
  }

  // =====================
  // NOTICIAS
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
    "busca e apreensão",
    "trump",
    "comunismo",
    "debate",
    "vivo"
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
  // MÉDICO
  // =====================
  const medico = [

    "ultra-som",
    "ultrassom",
    "abdômen",
    "abdomen",
    "receita",
    "consulta",
    "doutor",
    "exame",
    "impetigo"
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
  // SPAM
  // =====================
  if (

    /(.)\1{7,}/.test(lower)

  ) {

    return false;
  }

  // =====================
  // KEYWORDS
  // =====================
  const keywords = [

    "real",
    "reales",
    "reais",
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
  // FRASES HUMANAS
  // =====================
  const humanas = [

    "quiero enviar",
    "quero enviar",

    "quiero pasar",
    "quero passar",

    "quiero colocar",
    "quero colocar",

    "quiero cargar",

    "puedo enviar",

    "mandame pix",
    "manda pix",

    "mandame la llave",

    "esa tarjeta",
    "extra tarjeta",

    "perdi la cuenta",

    "como esta el cup",
    "como está el cup",

    "estas haciendo envio",
    "estás haciendo envío",

    "quiero hacer",

    "me manda el pix",

    "ya transferi",
    "ya transferí",

    "quiero mandar"
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
  // HUMANAS
  // =====================
  const tieneHumana =

    humanas.some(

      h =>
        lower.includes(h)
    );

  // =====================
  // NÚMEROS
  // =====================
  const tieneNumero =

    /\d+/.test(lower);

  // =====================
  // CUP / REAL
  // =====================
  const tieneCupReal =

    (
      lower.includes("cup")

      ||

      lower.includes("real")

      ||

      lower.includes("reales")

      ||

      lower.includes("reais")

      ||

      lower.includes("r$")
    );

  // =====================
  // TARJETA
  // =====================
  const tarjeta16 =

    /\b\d{16}\b/.test(

      lower.replace(/\s/g, "")
    );

  // =====================
  // REGLA FINAL
  // =====================
  if (

    tieneKeyword

    ||

    tieneHumana

    ||

    tarjeta16

    ||

    (
      tieneNumero &&
      tieneCupReal
    )

  ) {

    return true;
  }

  return false;
}

module.exports = {
  detectarIntencion
};
