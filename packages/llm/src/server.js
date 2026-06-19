// The `llm` MCP server — bring AI inside the OS.
//
// Wraps the configured provider API so Kernel-authorized callers (agents, the NL
// console, user macros) can make LLM calls that are capability-gated, audited,
// and subject to the same egress policy as net.fetch. Callers must hold `llm.*`
// or `llm.complete` to use it; default-deny applies like every other server.
//
// When the selected provider key is absent the server still loads (so callers get a
// sensible error rather than "unknown tool") and returns a mock response. This
// lets tests run without credentials while the smoke test exercises the real API.

import { providerOptions, resolveLlmCredential } from "./providers.js";

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_API_VER = "2023-06-01";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

async function readJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { error: { message: text || `HTTP ${res.status}` } }; }
}

async function callClaude(apiKey, model, prompt, system, credential) {
  const body = {
    model: model ?? credential.modelDefault,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
    ...(system ? { system } : {}),
  };
  const res = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": CLAUDE_API_VER, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok || data.error) throw new Error(data.error?.message ?? `Claude API error (${res.status})`);
  return { content: data.content?.[0]?.text ?? "", model: data.model, usage: data.usage, mock: false, provider: "claude" };
}

async function callOpenAI(apiKey, model, prompt, system, credential) {
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: prompt },
  ];
  const body = {
    model: model ?? credential.modelDefault,
    max_tokens: 2048,
    messages,
  };
  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok || data.error) throw new Error(data.error?.message ?? `OpenAI API error (${res.status})`);
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    model: data.model,
    usage: data.usage,
    mock: false,
    provider: "openai",
  };
}

async function callApi(tenantId, model, prompt, system) {
  const credential = resolveLlmCredential(tenantId);
  if (!credential.apiKey) {
    return {
      content: `(llm: ${credential.secretName} not set for ${credential.label})`,
      model: model ?? credential.modelDefault,
      mock: true,
      provider: credential.provider,
    };
  }
  if (credential.provider === "openai") {
    return callOpenAI(credential.apiKey, model, prompt, system, credential);
  }
  return callClaude(credential.apiKey, model, prompt, system, credential);
}

export function llmServer(deps) {
  const tenantId = deps.sandbox.tenant_id;
  return {
    name: "llm",
    tools: {
      complete: {
        description: "Run a prompt through the tenant's selected LLM provider.",
        inputSchema: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string" },
            model: { type: "string", description: "Optional provider-specific model id." },
            system: { type: "string", description: "Optional system prompt." },
          },
        },
        async handler(_ctx, a) {
          return callApi(tenantId, a.model, a.prompt, a.system);
        },
      },

      models: {
        description: "List known LLM models and provider configuration state.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          const credential = resolveLlmCredential(tenantId);
          return {
            provider: credential.provider,
            models: credential.models,
            configured: credential.configured,
            source: credential.source,
            providers: providerOptions(tenantId),
          };
        },
      },
    },
  };
}
