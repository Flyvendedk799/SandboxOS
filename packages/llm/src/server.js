// The `llm` MCP server — bring AI inside the OS.
//
// Wraps the tenant's selected provider so Kernel-authorized callers (agents, the NL
// console, user macros) can make LLM calls that are capability-gated, audited, and
// subject to the same egress policy as net.fetch. Callers must hold `llm.*` or
// `llm.complete` to use it; default-deny applies like every other server.
//
// Four request shapes (Anthropic, OpenAI chat, the Codex Responses API, Gemini), chosen
// by wires.js from the resolved credential. Within a wire the call is the same whether a
// key or a subscription pays — the difference is in the headers and (on Claude) in the
// first system block, both from packages/ai-auth. See its clients.js for why the identity
// block is not optional.
//
// When no credential is configured the server still loads (so callers get a sensible
// error rather than "unknown tool") and returns a mock response. This lets tests run
// without credentials while the smoke test exercises the real API.

import { describeProviderError } from "../../ai-auth/src/errors.js";
import { credentialHeaders, providerOptions, resolveLlmCredential, systemFor } from "./providers.js";
import {
  assertNotUpgradeNotice, codexBody, collectCodex, geminiBody, geminiResult, protocolOf,
  responsesUser, urlFor,
} from "./wires.js";

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
    describeProviderError(shaped, credential.provider, model, { configureAt: "Settings" }) ?? raw,
  );
}

const done = (credential, content, model, usage) => ({
  content, model, usage, mock: false, provider: credential.provider, billing: credential.billing,
});

async function post(credential, model, body, opts) {
  return fetch(urlFor(credential, model, opts), {
    method: "POST", headers: credentialHeaders(credential), body: JSON.stringify(body),
  });
}

/**
 * Anthropic. Deliberately nothing beyond model, max_tokens, messages and system: the 5.x
 * models refuse a non-default temperature/top_p/top_k, `thinking: {type: "disabled"}`
 * and `budget_tokens` with a 400, so the only safe sampling setting is none at all.
 * `effort`, when given, is the supported dial (output_config.effort).
 */
async function callAnthropic(credential, model, prompt, system, effort) {
  const body = {
    model,
    // Thinking is always on for the current models and counts against this cap.
    max_tokens: 16000,
    messages: [{ role: "user", content: prompt }],
    // A subscription token must open with the Claude Code identity block, in first
    // position, as a block of its own. systemFor is what guarantees that.
    ...(system || credential.provider === "claude-code" ? { system: systemFor(credential, system) } : {}),
    ...(effort ? { output_config: { effort } } : {}),
  };
  const res = await post(credential, model, body);
  const data = await readJson(res);
  if (!res.ok || data.error) throw providerError(res, data, credential, model);
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return done(credential, text, data.model ?? model, data.usage);
}

/** OpenAI chat completions. `max_completion_tokens`: GPT-5 and o-series refuse `max_tokens`. */
async function callOpenAI(credential, model, prompt, system) {
  const body = {
    model,
    max_completion_tokens: 2048,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
  };
  const res = await post(credential, model, body);
  const data = await readJson(res);
  if (!res.ok || data.error) throw providerError(res, data, credential, model);
  return done(credential, data.choices?.[0]?.message?.content ?? "", data.model ?? model, data.usage);
}

/** Codex: the Responses API, streamed (the backend accepts nothing else) and read whole. */
async function callCodex(credential, model, prompt, system) {
  const res = await post(credential, model, codexBody(model, { system, input: [responsesUser(prompt)] }));
  if (!res.ok) throw providerError(res, await readJson(res), credential, model);
  const out = await collectCodex(res);
  return done(credential, out.text, model, out.usage ? { input_tokens: out.usage.input, output_tokens: out.usage.output } : undefined);
}

/** Gemini: AI Studio on a key, Cloud Code on a subscription; the body shape follows. */
async function callGemini(credential, model, prompt, system) {
  const res = await post(credential, model, geminiBody(credential, model, { system, contents: prompt }));
  const data = await readJson(res);
  if (!res.ok || data.error) throw providerError(res, data, credential, model);
  const r = geminiResult(data);
  assertNotUpgradeNotice(credential, r.text);
  return done(credential, r.text, model, r.usage ? { input_tokens: r.usage.input, output_tokens: r.usage.output } : undefined);
}

async function callApi(tenantId, model, prompt, system, effort) {
  const credential = await resolveLlmCredential(tenantId, null, { model });
  const chosen = credential.model;
  if (!credential.configured) {
    return {
      content: `(llm: ${credential.error})`,
      model: chosen,
      mock: true,
      provider: credential.provider,
      billing: credential.billing,
    };
  }
  switch (protocolOf(credential)) {
    case "responses": return callCodex(credential, chosen, prompt, system);
    case "chat": return callOpenAI(credential, chosen, prompt, system);
    case "gemini": return callGemini(credential, chosen, prompt, system);
    default: return callAnthropic(credential, chosen, prompt, system, effort);
  }
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
            model: {
              type: "string",
              description: "Optional model id. Defaults to the tenant's chosen model, else the provider's catalogue default (see llm.models).",
            },
            system: { type: "string", description: "Optional system prompt." },
            effort: {
              type: "string", enum: ["low", "medium", "high", "xhigh", "max"],
              description: "Optional effort level. Claude providers only; ignored elsewhere.",
            },
          },
        },
        async handler(_ctx, a) {
          return callApi(tenantId, a.model, a.prompt, a.system, a.effort);
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
            model: credential.modelDefault,
            catalogueDefault: credential.catalogueDefault,
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
