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

    const mensagem =
      req.body.text?.message ||
      req.body.message ||
      "Mensagem recebida";

    const numero =
      req.body.phone ||
      req.body.chatId ||
      "";

    const respostaOpenAI = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: `
Você é Yorda-Bot.

Especialista em remessas Brasil → Cuba.

REGRAS:
- Responder curto.
- Falar igual humano.
- Responder no idioma do cliente.
- Nunca inventar taxas.
- Nunca confirmar pagamento automaticamente.
- Explicar que Yordanys pode responder depois.
- Ajudar com reais, CUP, USD, transferência e recargas.
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
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const texto =
      respostaOpenAI.data.choices[0].message.content;

    await axios.post(process.env.ZAPI_URL, {
      phone: numero,
      message: texto,
    });

    res.status(200).send("OK");
  } catch (error) {
    console.log(
      error.response?.data || error.message
    );

    res.status(500).send("Erro");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor online na porta ${PORT}`);
});
