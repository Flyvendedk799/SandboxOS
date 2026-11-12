// AI agent tool loop — the Phase-4 LLM-native agent kind.
//
// The agent receives a prompt + system, then drives a conversation loop:
//   1. Present available Kernel tools (filtered to the agent's capability patterns)
//      as Anthropic tool definitions.
//   2. Claude picks tools → we call kernel.call() on behalf of the agent.
//   3. Feed results back until stop_reason = "end_turn" or MAX_ITER reached.
//
// Tool names: Anthropic requires [a-zA-Z0-9_-], so we encode "server.tool" as
// "server__tool" (double underscore) and decode on the way back. On a Claude
// subscription the name also takes Claude Code's `mcp__` namespace (see wires.js).
//
// Four request shapes, one per protocol (wires.js): Anthropic messages, OpenAI chat
// completions, the Codex Responses API, and Gemini generateContent.
//
// When the selected provider key is absent the loop short-circuits immediately with a
// mock "done" result so tests can exercise the spawn/get lifecycle without creds.

import { authorize } from "../../kernel/src/capabilities.js";
import { updateAgentState, grantsFor } from "../../control-db/src/registry.js";
import { credentialHeaders, resolveLlmCredential, systemFor } from "../../llm/src/providers.js";
import {
  assertNotUpgradeNotice, codexBody, collectCodex, decodeToolName, encodeToolName, geminiBody,
  geminiResult, geminiToolResult, protocolOf, responsesAssistant, responsesUser, shapeTools, urlFor,
} from "../../llm/src/wires.js";
import { describeProviderError } from "../../ai-auth/src/errors.js";

const MAX_ITER = 20;

// Per-agent budget bounds (backlog #13 — AI agent budget bound).
// The tool loop is otherwise unbounded except for MAX_ITER, so a single agent
// can burn wall-clock and tokens indefinitely (e.g. a model that keeps calling
// tools). We cap BOTH dimensions: a wall-clock deadline and a cumulative token
// budget across all iterations. Both are env-tunable; defaults are sane for an
// interactive Haiku tool loop. Read lazily so tests/operators can override per
// process without re-importing (matches the SANDBOXOS_* convention elsewhere).
const agentMaxMs = () => Number(process.env.SANDBOXOS_AGENT_MAX_MS ?? 5 * 60_000); // ~5 min
const agentMaxTokens = () => Number(process.env.SANDBOXOS_AGENT_MAX_TOKENS ?? 200_000);

// ---- tool definitions ----------------------------------------------------------

/** Convert "server.tool" → "server__tool" and back (`mcp__server__tool` decodes too). */
export const encodeName = (server, tool, credential = null) => encodeToolName(credential, server, tool);
export const decodeName = (n) => decodeToolName(n);

/** The tools these patterns authorize, as `{ name, description, schema }` for wires.js. */
function allowedTools(allTools, patterns, credential = null) {
  return allTools
    .filter((t) => {
      const dot = t.name.indexOf(".");
      return !!authorize(patterns, t.name.slice(0, dot), t.name.slice(dot + 1));
    })
    .map((t) => {
      const dot = t.name.indexOf(".");
      return {
        name: encodeName(t.name.slice(0, dot), t.name.slice(dot + 1), credential),
        description: t.description ?? t.name,
        schema: t.inputSchema ?? { type: "object", properties: {} },
      };
    });
}

/**
 * Anthropic tool definitions from the Kernel catalog, filtered to the patterns the
 * agent actually holds.
 */
export function buildToolDefs(allTools, patterns, credential = null) {
  return shapeTools(credential ?? { wire: "anthropic" }, allowedTools(allTools, patterns, credential));
}

/** The same, in OpenAI chat-completions shape. */
export function buildOpenAIToolDefs(allTools, patterns, credential = null) {
  return shapeTools({ wire: "openai", provider: "openai" }, allowedTools(allTools, patterns, credential));
}

// ---- the calls ---------------------------------------------------------------

async function readJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { error: { message: text || `HTTP ${res.status}` } }; }
}

/**
 * The most useful sentence available for a failed provider response — the same mapping
 * the Assistant and the `llm` server use, so an agent's failure reads like theirs.
 */
function providerFailure(res, data, credential, model) {
  const raw = data?.error?.message ?? `${credential.label} error (${res.status})`;
  const shaped = { status: res.status, message: JSON.stringify({ message: raw }), headers: res.headers };
  return new Error(
    describeProviderError(shaped, credential.provider, model, { configureAt: "Settings" }) ?? raw,
  );
}

async function post(credential, model, body) {
  return fetch(urlFor(credential, model), {
    method: "POST", headers: credentialHeaders(credential), body: JSON.stringify(body),
  });
}

async function postJson(credential, model, body) {
  const res = await post(credential, model, body);
  const data = await readJson(res);
  if (!res.ok || data.error) throw providerFailure(res, data, credential, model);
  return data;
}

/**
 * Anthropic. No temperature, no `thinking`, no forced tool_choice and no assistant
 * prefill: each is a 400 on the 5.x models, so the body carries none of them.
 */
async function callAnthropic(credential, { model, system, tools, messages }) {
  return postJson(credential, model, {
    model,
    // Thinking is always on for the current models and counts against this cap.
    max_tokens: 16000,
    messages,
    ...(tools.length ? { tools } : {}),
    // A subscription token must carry the Claude Code identity as its first system
    // block; systemFor is a no-op on a metered key.
    ...(system || credential.provider === "claude-code" ? { system: systemFor(credential, system) } : {}),
  });
}

/** OpenAI chat completions. `max_completion_tokens`: GPT-5 and o-series refuse `max_tokens`. */
async function callOpenAI(credential, { model, tools, messages }) {
  return postJson(credential, model, {
    model, messages, max_completion_tokens: 4096, ...(tools.length ? { tools, tool_choice: "auto" } : {}),
  });
}

/** One tool call through the Kernel, as the agent, on behalf of whoever spawned it. */
async function runTool(kernel, { agentPrincipalId, spawnedBy, held }, name, args) {
  const [server, tool] = decodeName(name ?? "");
  const r = await kernel.call({
    principalId: agentPrincipalId,
    heldPatterns: held,
    server, tool,
    args: args ?? {},
    onBehalfOf: spawnedBy,
  });
  return r.ok ? JSON.stringify(r.result) : `Error: ${r.error}`;
}

// ---- main runner -------------------------------------------------------------

export async function runAI(agentId, { agentPrincipalId, spawnedBy, patterns, prompt, systemPrompt, kernel, sandbox, model }) {
  const credential = await resolveLlmCredential(sandbox.tenant_id, null, { model });

  updateAgentState(agentId, "running", { startedAt: Date.now() });

  if (!credential.configured) {
    updateAgentState(agentId, "done", {
      result: `(AI agent: ${credential.error})`,
      finishedAt: Date.now(),
    });
    return;
  }

  const held = grantsFor(agentPrincipalId, sandbox.id);

  // Budget bounds (backlog #13): capture the wall-clock deadline and token
  // ceiling once at the start of the run. `tokensUsed` accumulates across every
  // iteration; `lastText` holds the most recent assistant text so a budget cut
  // still surfaces whatever partial output the agent produced.
  const maxMs = agentMaxMs();
  const budget = {
    maxMs,
    maxTokens: agentMaxTokens(),
    deadline: Date.now() + maxMs,
    tokensUsed: 0,
    lastText: "",
  };

  const run = { agentPrincipalId, spawnedBy, patterns, prompt, systemPrompt, kernel, held, credential, budget };
  try {
    switch (protocolOf(credential)) {
      case "chat": await runOpenAIToolLoop(agentId, run); break;
      case "responses": await runCodexToolLoop(agentId, run); break;
      case "gemini": await runGeminiToolLoop(agentId, run); break;
      default: await runClaudeToolLoop(agentId, run); break;
    }
  } catch (e) {
    updateAgentState(agentId, "failed", { error: e.message, finishedAt: Date.now() });
  }
}

/** The checks every loop makes at the top of an iteration; true when the run is over. */
function outOfTime(agentId, budget) {
  if (Date.now() < budget.deadline) return false;
  finalizeBudgetExhausted(agentId, `wall-clock budget exhausted (${budget.maxMs}ms)`, budget.lastText, budget.tokensUsed);
  return true;
}
function outOfTokens(agentId, budget) {
  if (budget.tokensUsed < budget.maxTokens) return false;
  finalizeBudgetExhausted(agentId, `token budget exhausted (${budget.tokensUsed}/${budget.maxTokens} tokens)`, budget.lastText, budget.tokensUsed);
  return true;
}
const finished = (agentId, text) =>
  updateAgentState(agentId, "done", { result: text || "(no text output)", finishedAt: Date.now() });

async function runClaudeToolLoop(agentId, run) {
  const { patterns, prompt, systemPrompt, kernel, credential, budget } = run;
  const tools = shapeTools(credential, allowedTools(kernel.listTools(), patterns, credential));
  const messages = [{ role: "user", content: prompt }];

  for (let iter = 0; iter < MAX_ITER; iter++) {
    if (outOfTime(agentId, budget)) return;

    const resp = await callAnthropic(credential, { model: credential.model, system: systemPrompt, tools, messages });
    const usage = resp.usage ?? {};
    budget.tokensUsed += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);

    const content = resp.content ?? [];
    const respText = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (respText) budget.lastText = respText;

    if (resp.stop_reason === "end_turn" || !content.some((b) => b.type === "tool_use")) {
      return finished(agentId, respText);
    }
    messages.push({ role: "assistant", content });

    if (outOfTokens(agentId, budget)) return;

    const toolResults = [];
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: await runTool(kernel, run, block.name, block.input),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  updateAgentState(agentId, "failed", { error: `max iterations (${MAX_ITER}) reached`, finishedAt: Date.now() });
}

async function runOpenAIToolLoop(agentId, run) {
  const { patterns, prompt, systemPrompt, kernel, credential, budget } = run;
  const tools = shapeTools(credential, allowedTools(kernel.listTools(), patterns, credential));
  const messages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    { role: "user", content: prompt },
  ];

  for (let iter = 0; iter < MAX_ITER; iter++) {
    if (outOfTime(agentId, budget)) return;

    const resp = await callOpenAI(credential, { model: credential.model, tools, messages });
    const choice = resp.choices?.[0]?.message ?? {};
    const usage = resp.usage ?? {};
    budget.tokensUsed += usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0));

    messages.push(choice);
    const respText = choice.content ?? "";
    if (respText) budget.lastText = respText;

    const toolCalls = choice.tool_calls ?? [];
    if (!toolCalls.length) return finished(agentId, respText);
    if (outOfTokens(agentId, budget)) return;

    for (const call of toolCalls) {
      let args = {};
      try { args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}; }
      catch { args = {}; }
      messages.push({ role: "tool", tool_call_id: call.id, content: await runTool(kernel, run, call.function?.name, args) });
    }
  }
  updateAgentState(agentId, "failed", { error: `max iterations (${MAX_ITER}) reached`, finishedAt: Date.now() });
}

/**
 * Codex: the Responses API. With `store: false` nothing persists between calls, so the
 * whole conversation is resent as input items each time — the function calls echoed
 * back by call id, without the server ids the backend did not keep.
 */
async function runCodexToolLoop(agentId, run) {
  const { patterns, prompt, systemPrompt, kernel, credential, budget } = run;
  const tools = shapeTools(credential, allowedTools(kernel.listTools(), patterns, credential));
  const input = [responsesUser(prompt)];

  for (let iter = 0; iter < MAX_ITER; iter++) {
    if (outOfTime(agentId, budget)) return;

    const model = credential.model;
    const res = await post(credential, model, codexBody(model, { system: systemPrompt, input, tools }));
    if (!res.ok) throw providerFailure(res, await readJson(res), credential, model);
    const out = await collectCodex(res);
    budget.tokensUsed += (out.usage?.input ?? 0) + (out.usage?.output ?? 0);
    if (out.text) budget.lastText = out.text;

    if (!out.calls.length) return finished(agentId, out.text);
    if (out.text) input.push(responsesAssistant(out.text));
    if (outOfTokens(agentId, budget)) return;

    for (const call of out.calls) {
      input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.args || "{}" });
      let args = {};
      try { args = call.args ? JSON.parse(call.args) : {}; } catch { args = {}; }
      input.push({ type: "function_call_output", call_id: call.id, output: await runTool(kernel, run, call.name, args) });
    }
  }
  updateAgentState(agentId, "failed", { error: `max iterations (${MAX_ITER}) reached`, finishedAt: Date.now() });
}

/**
 * Gemini, on a key or a subscription. The model's function-call parts go back exactly
 * as they came — Gemini 3 refuses a call returned without its thoughtSignature.
 */
async function runGeminiToolLoop(agentId, run) {
  const { patterns, prompt, systemPrompt, kernel, credential, budget } = run;
  const tools = shapeTools(credential, allowedTools(kernel.listTools(), patterns, credential));
  const contents = [{ role: "user", parts: [{ text: prompt }] }];

  for (let iter = 0; iter < MAX_ITER; iter++) {
    if (outOfTime(agentId, budget)) return;

    const model = credential.model;
    const data = await postJson(credential, model, geminiBody(credential, model, { system: systemPrompt, contents, tools }));
    const r = geminiResult(data);
    assertNotUpgradeNotice(credential, r.text);
    budget.tokensUsed += (r.usage?.input ?? 0) + (r.usage?.output ?? 0);
    if (r.text) budget.lastText = r.text;

    if (!r.calls.length) return finished(agentId, r.text);
    contents.push({ role: "model", parts: r.parts.length ? r.parts : r.calls.map((c) => c.part) });
    if (outOfTokens(agentId, budget)) return;

    const parts = [];
    for (const call of r.calls) {
      parts.push(geminiToolResult(call.name, await runTool(kernel, run, call.name, call.args)));
    }
    contents.push({ role: "user", parts });
  }
  updateAgentState(agentId, "failed", { error: `max iterations (${MAX_ITER}) reached`, finishedAt: Date.now() });
}

/**
 * Finalize an agent whose wall-clock or token budget was exhausted (backlog
 * #13). We mark it "done" (the work it did complete is valid) with a result
 * that clearly states the budget cut and includes any partial text, so the cut
 * is visible to the operator rather than failing silently or running unbounded.
 */
function finalizeBudgetExhausted(agentId, reason, lastText, tokensUsed) {
  const partial = lastText ? `\n\n--- partial output before cutoff ---\n${lastText}` : "";
  updateAgentState(agentId, "done", {
    result: `(AI agent halted: ${reason}; ~${tokensUsed} tokens used)${partial}`,
    finishedAt: Date.now(),
  });
}
