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

  // =========================
  // ASSISTANT FUNCTIONS
  // =========================
  for (const tc of toolCalls) {

    // =========================
    // CALCULAR REMESA
    // =========================
    if (
      tc.function.name ===
      "calcular_tasa_remesa"
    ) {

      const args =
        JSON.parse(
          tc.function.arguments
        );

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

  // =========================
  // ENVIAR RESULTADOS
  // =========================
  await axios.post(

`https://api.openai.com/v1/threads/${threadId}/runs/${run.data.id}/submit_tool_outputs`,

    {
      tool_outputs:
        outputs
    },

    { headers }
  );

}
