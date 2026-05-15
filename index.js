
const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

// ======================================
// MEMÓRIA TEMPORÁRIA
// ======================================

const ultimaResposta = {};
const clientesAtivos = {};

// ======================================
// CONFIGURAÇÕES
// ======================================

const TEMPO_COOLDOWN = 60000;

const gatilhos = [
  "real",
  "reales",
  "cup",
  "usd",
  "dolar",
  "dólar",
  "taxa",
  "tasa",
  "remesa",
  "transferencia",
  "transferência",
  "dinero",
  "enviar",
  "mlc",
  "pix",
  "recarga",
  "saldo",
  "cuba",
  "deposito",
  "depósito",
  "cartão",
  "cartao",
  "tarjeta",
  "banco",
  "usdt",
  "crypto",
  "criptomoneda",
  "internet",
  "sms",
  "llamadas",
  "etecsa"
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

    // ==================================
    // IGNORAR STATUS
    // ==================================

    if (
      req.body.type === "MessageStatusCallback"
    ) {
      return res
        .status(200)
        .send("Status ignorado");
    }

    // ==================================
    // IGNORAR GRUPOS
    // ==================================

    if (req.body.isGroup) {
      return res
        .status(200)
        .send("Grupo ignorado");
    }

    // ==================================
    // IGNORAR MENSAGENS PRÓPRIAS
    // ==================================

    if (req.body.fromMe) {
      return res
        .status(200)
        .send("Mensagem própria ignorada");
    }

    // ==================================
    // DADOS
    // ==================================

    const mensagem =
      req.body.text?.message ||
      req.body.message ||
      "";

    const numero =
      req.body.phone ||
      "";

    const nome =
      req.body.senderName ||
      "Cliente";

    if (!mensagem || !numero) {
      return res
        .status(200)
        .send("Mensagem inválida");
    }

    // ==================================
    // ANTI FLOOD
    // ==================================

    const agora = Date.now();

    if (
      ultimaResposta[numero] &&
      agora - ultimaResposta[numero]
      < TEMPO_COOLDOWN
    ) {

      return res
        .status(200)
        .send("Cooldown ativo");
    }

    // ==================================
    // TEXTO LOWER
    // ==================================

    const textoLower =
      mensagem.toLowerCase();

    // ==================================
    // GATILHOS
    // ==================================

    const ativouRemessa =
      gatilhos.some(g =>
        textoLower.includes(g)
      );

    // ==================================
    // RESPOSTA NEUTRA
    // ==================================

    if (
      !ativouRemessa &&
      !clientesAtivos[numero]
    ) {

      await enviarMensagem(
        numero,
        "Hola 👋 ¿Cómo puedo ayudarte?"
      );

      ultimaResposta[numero] = agora;

      return res
        .status(200)
        .send("Mensagem neutra enviada");
    }

    // ==================================
    // CLIENTE ATIVO
    // ==================================

    clientesAtivos[numero] = true;

    // ==================================
    // TAXAS DINÂMICAS
    // ==================================

    const taxaMenor100 =
      process.env.TASA_MENOR_100 || "100";

    const taxa100_499 =
      process.env.TASA_100_499 || "115";

    const taxa500 =
      process.env.TASA_500 || "118";

    const usdBrl =
      process.env.USD_BRL || "5.60";

    // ==================================
    // OPENAI
    // ==================================

    const respostaOpenAI =
      await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {

          model: "gpt-4.1-mini",

          messages: [

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
- Transferências

=================================
TAXAS REMESSAS
=================================

Menor de 100 reais:
${taxaMenor100} CUP

100 até 499 reais:
${taxa100_499} CUP

500+ reais:
${taxa500} CUP

USD:
1 USD = ${usdBrl} BRL

=================================
RECARGA ETECSA
=================================

Promoção atual:

Cada 100 reais =
2000 CUP de saldo.

Esse saldo:
- dura 365 dias
- permite comprar:
internet,
planos,
SMS,
ligações.

=================================
REGRAS
=================================

- Responder curto.
- Falar igual humano.
- Responder no idioma do cliente.
- Nunca inventar taxas.
- Nunca confirmar pagamento automaticamente.
- Nunca prometer horário exato.
- Nunca responder grupos.
- Não usar textos muito longos.
- Ser amigável.
- Não repetir mensagens.
- Responder profissionalmente.

=================================
COMPORTAMENTO
=================================

SE perguntarem taxas:
usar SEMPRE as taxas acima.

SE perguntarem recarga:
explicar SEMPRE:

"Cada 100 reales recibe
2000 CUP de saldo válido
por 365 días.
Puede comprar internet,
planes, SMS y llamadas."

SE perguntarem promoção:
usar informações acima.

SE perguntarem comprovante do cliente:
dizer:

"Comprovante recebido ✅
Tudo certo.
Sua transferência será processada."

SE perguntarem comprovante da transferência enviada:
dizer:

"Devido aos problemas de energia em Cuba,
algumas transferências podem demorar um pouco mais.

Assim que a transferência for concluída,
o comprovante será enviado 😊"

SE pedirem chave PIX:
informar:

"Pode realizar o pagamento pela chave PIX abaixo 👇

8becaaf5-f296-4cbc-a115-46e3d23b042a"

Nunca enviar a chave PIX automaticamente.
Enviar SOMENTE se o cliente pedir.

SE pedirem Yordanys:
dizer:

"Claro 😊
Enseguida Yordanys continuará con tu atención."

SE falarem algo fora remessa:
responder educadamente.

Nunca usar mensagens gigantes.
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
              \`Bearer \${process.env.OPENAI_API_KEY}\`,

            "Content-Type":
              "application/json"

          }
        }
      );

    // ==================================
    // PEGAR RESPOSTA
    // ==================================

    const texto =
      respostaOpenAI.data
      .choices[0]
      .message.content;

    // ==================================
    // ENVIAR MENSAGEM
    // ==================================

    await enviarMensagem(
      numero,
      texto
    );

    ultimaResposta[numero] = agora;

    // ==================================
    // FINAL
    // ==================================

    res.status(200).send("OK");

  } catch (error) {

    console.log(
      error.response?.data ||
      error.message
    );

    res.status(500).send("Erro");
  }
});

// ======================================
// FUNÇÃO ENVIAR WHATSAPP
// ======================================

async function enviarMensagem(
  numero,
  texto
) {

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
}

// ======================================
// PORTA
// ======================================

const PORT =
  process.env.PORT || 3000;

// ======================================
// START
// ======================================

app.listen(PORT, () => {

  console.log(
    \`Servidor online na porta \${PORT}\`
  );

});
