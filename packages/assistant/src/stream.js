// Provider streaming: turn an SSE HTTP response into normalized events.
//
// Anthropic and OpenAI both stream over SSE but describe a turn differently —
// Anthropic emits typed content blocks with deltas, OpenAI emits a delta object
// with an array of partial tool calls. Both are reduced here to one vocabulary:
//
//   { type: "text",       text }            incremental assistant prose
//   { type: "tool_start", id, name }        a tool call has begun
//   { type: "tool_args",  id, partial }     incremental JSON for that call
//   { type: "usage",      input, output }   token accounting
//   { type: "stop",       reason }          the turn ended
//
// Everything above the transport works in that vocabulary and never learns which
// provider it is talking to.

/** Read an SSE body line by line, yielding parsed `data:` payloads. */
export async function* sseFrames(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data || data === "[DONE]") continue;
        try { yield JSON.parse(data); } catch { /* keepalive or partial frame */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Anthropic messages stream → normalized events. */
export async function* anthropicEvents(res) {
  /** content block index → tool-call id, so input_json_delta can be attributed. */
  const blocks = new Map();
  for await (const ev of sseFrames(res)) {
    switch (ev.type) {
      case "content_block_start": {
        const b = ev.content_block ?? {};
        if (b.type === "tool_use") {
          blocks.set(ev.index, b.id);
          yield { type: "tool_start", id: b.id, name: b.name };
        }
        break;
      }
      case "content_block_delta": {
        const d = ev.delta ?? {};
        if (d.type === "text_delta") yield { type: "text", text: d.text };
        else if (d.type === "input_json_delta") {
          yield { type: "tool_args", id: blocks.get(ev.index), partial: d.partial_json };
        }
        break;
      }
      case "message_start":
        yield { type: "usage", input: ev.message?.usage?.input_tokens ?? 0, output: 0 };
        break;
      case "message_delta":
        yield { type: "usage", input: 0, output: ev.usage?.output_tokens ?? 0 };
        if (ev.delta?.stop_reason) yield { type: "stop", reason: ev.delta.stop_reason };
        break;
      case "error":
        throw new Error(ev.error?.message ?? "provider stream error");
      default:
        break;
    }
  }
}

/** OpenAI chat-completions stream → normalized events. */
export async function* openaiEvents(res) {
  /** tool_calls come back indexed, and only the first chunk carries id + name. */
  const byIndex = new Map();
  for await (const ev of sseFrames(res)) {
    if (ev.error) throw new Error(ev.error.message ?? "provider stream error");
    if (ev.usage) {
      yield { type: "usage", input: ev.usage.prompt_tokens ?? 0, output: ev.usage.completion_tokens ?? 0 };
    }
    const choice = ev.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (delta.content) yield { type: "text", text: delta.content };
    for (const call of delta.tool_calls ?? []) {
      let id = byIndex.get(call.index);
      if (call.id && !id) {
        id = call.id;
        byIndex.set(call.index, id);
        yield { type: "tool_start", id, name: call.function?.name ?? "" };
      }
      if (call.function?.arguments) {
        yield { type: "tool_args", id: id ?? String(call.index), partial: call.function.arguments };
      }
    }
    if (choice.finish_reason) yield { type: "stop", reason: choice.finish_reason };
  }
}
