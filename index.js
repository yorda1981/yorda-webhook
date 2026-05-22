async function procesarMensaje(phone, textMessage) {
try {

```
const headers = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2"
};

let threadId = await getThread(phone);

if (!threadId) {

  const thread = await axios.post(
    "https://api.openai.com/v1/threads",
    {},
    { headers }
  );

  threadId = thread.data.id;

  await setThread(
    phone,
    threadId
  );
}

await axios.post(
```

`https://api.openai.com/v1/threads/${threadId}/messages`,
{
role: "user",
content: textMessage
},
{ headers }
);

```
let run = await axios.post(
```

`https://api.openai.com/v1/threads/${threadId}/runs`,
{
assistant_id:
"asst_0iCMGSSNWcXP7H6Eo1yEM536"
},
{ headers }
);

```
const startedAt =
  Date.now();

let completed =
  false;

while (!completed) {

  if (
    Date.now() -
    startedAt >
    45000
  ) {

    throw new Error(
      "Run timeout"
    );
  }

  await new Promise(
    r =>
      setTimeout(r, 1500)
  );

  const check =
    await axios.get(
```

`https://api.openai.com/v1/threads/${threadId}/runs/${run.data.id}`,
{ headers }
);

```
  // =========================
  // COMPLETED
  // =========================
  if (
    check.data.status ===
    "completed"
  ) {

    completed = true;

  // =========================
  // FUNCTIONS
  // =========================
  } else if (

    check.data.status ===
    "requires_action"

  ) {

    const toolCalls =
      check.data
      .required_action
      .submit_tool_outputs
      .tool_calls;

    const outputs = [];

    for (const tc of toolCalls) {

      // =========================
      // DETECTAR INTENCION
      // =========================
      if (
        tc.function.name ===
        "detectar_intencion"
      ) {

        outputs.push({

          tool_call_id:
            tc.id,

          output:
            JSON.stringify({
              ok: true
            })
        });
      }

      // =========================
      // CALCULAR REMESA
      // =========================
      if (
        tc.function.name ===
        "calcular_tasa_remesa"
      ) {

        outputs.push({

          tool_call_id:
            tc.id,

          output:
            JSON.stringify({
              ok: true
            })
        });
      }
    }

    await axios.post(
```

`https://api.openai.com/v1/threads/${threadId}/runs/${run.data.id}/submit_tool_outputs`,
{
tool_outputs:
outputs
},
{ headers }
);

```
  } else if (

    [
      "failed",
      "expired",
      "cancelled"
    ].includes(
      check.data.status
    )

  ) {

    throw new Error(
      `Run ${check.data.status}`
    );
  }
}

const messages =
  await axios.get(
```

`https://api.openai.com/v1/threads/${threadId}/messages`,
{ headers }
);

```
const respuesta =
  messages.data.data[0]
  ?.content?.[0]
  ?.text?.value;

if (respuesta) {

  await enviarMensaje(
    phone,
    respuesta
  );
}
```

} catch (e) {

```
logger(
  "error",
  "AGENT_ERROR",
  {
    phone,
    err: e.message
  }
);

await enviarMensaje(
  phone,
```

`Lo siento 🙏

Estoy teniendo una demora momentánea.`
);
}
}
