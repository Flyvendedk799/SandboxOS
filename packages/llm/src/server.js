// The `llm` MCP server — bring AI inside the OS.
//
// Wraps the Anthropic Messages API so Kernel-authorized callers (agents, the NL
// console, user macros) can make LLM calls that are capability-gated, audited,
// and subject to the same egress policy as net.fetch. Callers must hold `llm.*`
// or `llm.complete` to use it; default-deny applies like every other server.
//
// When ANTHROPIC_API_KEY is absent the server still loads (so callers get a
// sensible error rather than "unknown tool") and returns a mock response. This
// lets tests run without credentials while the smoke test exercises the real API.

const MODELS = ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8"];
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VER = "2023-06-01";

async function callApi(model, prompt, system) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { content: "(llm: ANTHROPIC_API_KEY not set)", model, mock: true };
  const body = {
    model: model ?? DEFAULT_MODEL,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
    ...(system ? { system } : {}),
  };
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": API_VER, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message ?? JSON.stringify(data.error));
  return { content: data.content[0].text, model: data.model, usage: data.usage, mock: false };
}

export function llmServer(_deps) {
  return {
    name: "llm",
    tools: {
      complete: {
        description: "Run a prompt through an LLM. Requires ANTHROPIC_API_KEY env var.",
        inputSchema: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string" },
            model: { type: "string", description: `Model id. Default: ${DEFAULT_MODEL}` },
            system: { type: "string", description: "Optional system prompt." },
          },
        },
        async handler(_ctx, a) {
          return callApi(a.model, a.prompt, a.system);
        },
      },

      models: {
        description: "List known LLM models and whether the API key is configured.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          return { models: MODELS, configured: !!process.env.ANTHROPIC_API_KEY };
        },
      },
    },
  };
}
