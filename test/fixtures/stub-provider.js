// A stand-in for Anthropic / OpenAI that speaks their streaming wire formats.
//
// The assistant's turn loop is the part worth testing — does it stream, does it
// route tool calls through the Kernel, does it stop when told — and none of that
// needs a real model. This fixture replays scripted turns over SSE so the loop
// can be exercised deterministically and offline.

import http from "node:http";

/**
 * @param {Array<{text?: string, tools?: Array<{name: string, args: object}>}>} script
 *        one entry per model turn, replayed in order.
 */
export function stubProvider(script, { flavor = "anthropic" } = {}) {
  let turn = 0;
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try { requests.push(JSON.parse(body)); } catch { requests.push({ _raw: body }); }
      const spec = script[Math.min(turn, script.length - 1)] ?? {};
      turn += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const frames = flavor === "openai" ? openaiFrames(spec) : anthropicFrames(spec);
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
      if (flavor === "openai") res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return {
    server,
    requests,
    get turns() { return turn; },
    async listen() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${server.address().port}/v1`;
    },
    close() { server.close(); },
  };
}

function anthropicFrames({ text, tools = [] }) {
  const out = [{ type: "message_start", message: { usage: { input_tokens: 12 } } }];
  let index = 0;
  if (text) {
    out.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    // Split into chunks so the consumer really has to reassemble a stream.
    for (const chunk of text.match(/.{1,7}/gs) ?? []) {
      out.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } });
    }
    out.push({ type: "content_block_stop", index });
    index += 1;
  }
  for (const t of tools) {
    const id = `toolu_${index}`;
    out.push({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: t.name, input: {} } });
    const json = JSON.stringify(t.args ?? {});
    for (const chunk of json.match(/.{1,5}/gs) ?? []) {
      out.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: chunk } });
    }
    out.push({ type: "content_block_stop", index });
    index += 1;
  }
  out.push({
    type: "message_delta",
    delta: { stop_reason: tools.length ? "tool_use" : "end_turn" },
    usage: { output_tokens: 34 },
  });
  out.push({ type: "message_stop" });
  return out;
}

function openaiFrames({ text, tools = [] }) {
  const out = [];
  if (text) {
    for (const chunk of text.match(/.{1,7}/gs) ?? []) {
      out.push({ choices: [{ delta: { content: chunk } }] });
    }
  }
  tools.forEach((t, i) => {
    out.push({ choices: [{ delta: { tool_calls: [{ index: i, id: `call_${i}`, function: { name: t.name, arguments: "" } }] } }] });
    const json = JSON.stringify(t.args ?? {});
    for (const chunk of json.match(/.{1,5}/gs) ?? []) {
      out.push({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: chunk } }] } }] });
    }
  });
  out.push({ choices: [{ delta: {}, finish_reason: tools.length ? "tool_calls" : "stop" }] });
  out.push({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 34 } });
  return out;
}
