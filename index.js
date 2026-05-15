const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Yorda-Bot online");
});

app.post("/webhook", async (req, res) => {
  try {

    console.log("Mensagem recebida:", req.body);

    // Ignorar grupos
    if (req.body.isGroup) {
      return res.status(200).send("Grupo ignorado");
    }

    // Ignorar mensagens próprias
    if (req.body.fromMe) {
      return res.status(200).send("Mensagem própria ignorada");
    }

    const mensagem =
      req.body.text?.message ||
      req.body.message ||
      "";

    const numero =
      req.body.phone ||
      req.body.chatId ||
      "";

    // Ignorar vazio
    if (!mensagem || !numero) {
      return res.status(200).send("Mensagem inválida");
    }

    // Gatilhos remessas
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
      "cartao"
    ];

    const textoLower = mensagem.toLowerCase();

    const ativouRemessa = gatilhos.some(g =>
      textoLower.includes(g)
    );

    // Resposta neutra se não ativar gatilho
    if (!ativouRemessa) {

      await axios.post(
        process.env.ZAPI_URL,
        {
          phone: numero,
          message:
            "Hola 👋 ¿Cómo puedo ayudarte?",
        },
        {
          headers: {
            "Client-Token":
              process.env.ZAPI_CLIENT_TOKEN,
            "Content-Type": "application/json",
          },
        }
      );

      return res
        .status(200)
        .send("Mensagem neutra enviada");
    }

    // OpenAI
    const respostaOpenAI = await axios.post(
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
- Recargas
- CUP
- USD
- Reais
- Transferências

REGRAS:
- Responder curto.
- Responder natural.
- Falar igual humano.
- Responder no idioma do cliente.
- Nunca inventar taxas.
- Nunca confirmar pagamento automaticamente.
- Nunca prometer horário exato.
- Explicar que Yordanys pode responder depois.
- Ser educado e profissional.
- Não responder grupos.
- Não repetir mensagens.
- Não usar textos muito longos.

Se perguntarem taxas:
informar que variam conforme valor enviado.

Se pedirem falar com Yordanys:
informar que ele pode responder depois.

Sempre tentar manter conversa natural.
`,
          },
          {
            role: "user",
            content: mensagem,
          },
        ],
      },
      {
        headers: {
          Authorization:
            `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const texto =
      respostaOpenAI.data.choices[0]
      .message.content;

    // Responder WhatsApp
    await axios.post(
      process.env.ZAPI_URL,
      {
        phone: numero,
        message: texto,
      },
      {
        headers: {
          "Client-Token":
            process.env.ZAPI_CLIENT_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    res.status(200).send("OK");

  } catch (error) {

    console.log(
      error.response?.data ||
      error.message
    );

    res.status(500).send("Erro");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `Servidor online na porta ${PORT}`
  );
});
