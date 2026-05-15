const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

// ======================================
// GATILHOS
// ======================================

const gatilhos = [
  "real",
  "reales",
  "cup",
  "usd",
  "dolar",
  "dólar",
  "taxa",
  "tasa",
  "cambio",
  "cmb",
  "mlc",
  "transferencia",
  "transferência",
  "remesa",
  "recarga",
  "pix",
  "saldo",
  "etecsa",
  "internet",
  "sms",
  "llamadas"
];

// ======================================
// HOME
// ======================================

app.get("/", (req, res) => {
  res.send("Yorda-Bot online 🚀");
});

// ======================================
// WEBHOOK
// ======================================

app.post("/webhook", async (req, res) => {

  try {

    console.log("Mensagem recebida:", req.body);

    // IGNORAR GRUPOS
    if (req.body.isGroup) {
      return res.sendStatus(200);
    }

    // IGNORAR MENSAGENS PRÓPRIAS
    if (req.body.fromMe) {
      return res.sendStatus(200);
    }

    // IGNORAR STATUS
    if (
      req.body.type === "MessageStatusCallback"
    ) {
      return res.sendStatus(200);
    }

    // ==================================
    // DADOS
    // ==================================

    const mensagem =
      req.body.text?.message || "";

    const numero =
      req.body.phone || "";

    if (!mensagem || !numero) {
      return res.sendStatus(200);
    }

    // ==================================
    // GATILHOS
    // ==================================

    const textoLower =
      mensagem.toLowerCase();

    const ativarBot =
      gatilhos.some(g =>
        textoLower.includes(g)
      );

    // NÃO RESPONDER SEM GATILHO
    if (!ativarBot) {
      return res.sendStatus(200);
    }

    // ==================================
    // OPENAI RESPONSES API
    // ==================================

    const respostaOpenAI = await axios.post(

      "https://api.openai.com/v1/responses",

      {
        model: "gpt-4o-mini",

        input: [

          {
            role: "system",

            content: `
Você é Yorda-Bot.

Especialista em:
- Remessas Brasil → Cuba
- Recargas ETECSA
- CUP
- USD
- PIX

=================================

TAXAS:

Menor de 100 reais:
100 CUP

100 até 499:
115 CUP

500+:
118 CUP

USD:
5.60 BRL

=================================

RECARGAS:

Cada 100 reais:
2000 CUP saldo.

O saldo dura 365 dias.

O familiar pode comprar:
- internet
- SMS
- chamadas

=================================

PIX:

Só enviar se o cliente pedir.

PIX:
8becaaf5-f296-4cbc-a115-46e3d23b042a

=================================

COMPROVANTES:

Se for comprovante enviado pelo cliente:

"Comprovante recebido ✅
Tudo certo.
Sua transferência será processada."

Se for comprovante da empresa:

"Devido aos problemas de energia em Cuba,
algumas transferências podem demorar um pouco mais.

Assim que a transferência for concluída,
o comprovante será enviado 😊"

=================================

YORDANYS:

Se pedirem Yordanys:

"Claro 😊
Enseguida Yordanys continuará con tu atención."

=================================

REGRAS:

- Responder curto.
- Falar igual humano.
- Responder no idioma do cliente.
- Nunca inventar taxas.
- Nunca confirmar pagamento automaticamente.
- Nunca prometer horário exato.
- Nunca responder grupos.
- Não escrever textos gigantes.
`
          },

          {
            role: "user",
            content: mensagem
          }

        ]
      },

      {
        headers: {
          Authorization:
            `Bearer ${process.env.OPENAI_API_KEY}`,

          "Content-Type":
            "application/json"
        }
      }
    );

    // ==================================
    // PEGAR TEXTO
    // ==================================

    const texto =
      respostaOpenAI.data
      .output[0]
      .content[0]
      .text;

    // ==================================
    // ENVIAR WHATSAPP
    // ==================================

    await axios.post(

      process.env.ZAPI_URL,

      {
        phone: numero,
        message: texto
      },

      {
        headers: {

          "Client-Token":
            process.env.ZAPI_CLIENT_TOKEN,

          "Content-Type":
            "application/json"
        }
      }
    );

    return res.sendStatus(200);

  } catch (error) {

    console.log(
      error.response?.data ||
      error.message
    );

    return res.sendStatus(500);
  }
});

// ======================================
// START
// ======================================

const PORT =
  process.env.PORT || 8080;

app.listen(PORT, () => {

  console.log(
    `Servidor online na porta ${PORT}`
  );

});
