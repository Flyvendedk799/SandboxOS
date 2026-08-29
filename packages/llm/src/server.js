// The `llm` MCP server — bring AI inside the OS.
//
// Wraps the tenant's selected provider so Kernel-authorized callers (agents, the NL
// console, user macros) can make LLM calls that are capability-gated, audited, and
// subject to the same egress policy as net.fetch. Callers must hold `llm.*` or
// `llm.complete` to use it; default-deny applies like every other server.
//
// The call is the same shape whether it is paid for by a key or by a subscription — the
// difference is entirely in the headers and (on Claude) in the first system block, and
// both of those come out of packages/ai-auth. See its clients.js for why the identity
// block is not optional.
//
// When no credential is configured the server still loads (so callers get a sensible
// error rather than "unknown tool") and returns a mock response. This lets tests run
// without credentials while the smoke test exercises the real API.

import { describeProviderError } from "../../ai-auth/src/errors.js";
import { CODEX_BASE_URL } from "../../ai-auth/src/clients.js";
import {
  baseUrlFor, credentialHeaders, providerOptions, resolveLlmCredential, systemFor,
} from "./providers.js";

const CLAUDE_API_URL = () => process.env.SANDBOXOS_ANTHROPIC_URL || "https://api.anthropic.com/v1/messages";
const OPENAI_API_URL = () => process.env.SANDBOXOS_OPENAI_URL || "https://api.openai.com/v1/chat/completions";
const CODEX_URL = () => process.env.SANDBOXOS_CODEX_URL || `${CODEX_BASE_URL}/chat/completions`;

async function readJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { error: { message: text || `HTTP ${res.status}` } }; }
}

/**
 * Turn a failed response into the most useful sentence available.
 *
 * `describeProviderError` needs the status *and* the headers, because a 429 that says
 * the plan is still allowed means something entirely different from one that does not —
 * so the response's headers are carried onto the error rather than only its body.
 */
function providerError(res, data, credential, model) {
  const raw = data?.error?.message ?? `${credential.label} error (${res.status})`;
  const shaped = { status: res.status, message: JSON.stringify({ message: raw }), headers: res.headers };
  return new Error(
    describeProviderError(shaped, credential.provider, model ?? credential.modelDefault, { configureAt: "Settings" })
    ?? raw,
  );
}

async function callAnthropic(credential, model, prompt, system) {
  const chosen = model ?? credential.modelDefault;
  const body = {
    model: chosen,
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
    // A subscription token must open with the Claude Code identity block, in first
    // position, as a block of its own. systemFor is what guarantees that.
    ...(system || credential.provider === "claude-code" ? { system: systemFor(credential, system) } : {}),
  };
  const res = await fetch(baseUrlFor(credential, CLAUDE_API_URL(), OPENAI_API_URL(), CODEX_URL()), {
    method: "POST",
    headers: credentialHeaders(credential),
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok || data.error) throw providerError(res, data, credential, chosen);
  return {
    content: data.content?.[0]?.text ?? "",
    model: data.model,
    usage: data.usage,
    mock: false,
    provider: credential.provider,
    billing: credential.billing,
  };
}

async function callOpenAI(credential, model, prompt, system) {
  const chosen = model ?? credential.modelDefault;
  const body = {
    model: chosen,
    max_tokens: 2048,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
  };
  const res = await fetch(baseUrlFor(credential, CLAUDE_API_URL(), OPENAI_API_URL(), CODEX_URL()), {
    method: "POST",
    headers: credentialHeaders(credential),
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok || data.error) throw providerError(res, data, credential, chosen);
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    model: data.model,
    usage: data.usage,
    mock: false,
    provider: credential.provider,
    billing: credential.billing,
  };
}

async function callApi(tenantId, model, prompt, system) {
  const credential = await resolveLlmCredential(tenantId);
  if (!credential.configured) {
    return {
      content: `(llm: ${credential.error})`,
      model: model ?? credential.modelDefault,
      mock: true,
      provider: credential.provider,
      billing: credential.billing,
    };
  }
  return credential.wire === "openai"
    ? callOpenAI(credential, model, prompt, system)
    : callAnthropic(credential, model, prompt, system);
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
          const credential = await resolveLlmCredential(tenantId);
          return {
            provider: credential.provider,
            billing: credential.billing,
            models: credential.models,
            configured: credential.configured,
            source: credential.source,
            providers: await providerOptions(tenantId),
          };
        },
      },
    },
  };
}
