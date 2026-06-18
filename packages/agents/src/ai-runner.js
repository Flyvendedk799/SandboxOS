// AI agent tool loop — the Phase-4 LLM-native agent kind.
//
// The agent receives a prompt + system, then drives a conversation loop:
//   1. Present available Kernel tools (filtered to the agent's capability patterns)
//      as Anthropic tool definitions.
//   2. Claude picks tools → we call kernel.call() on behalf of the agent.
//   3. Feed results back until stop_reason = "end_turn" or MAX_ITER reached.
//
// Tool names: Anthropic requires [a-zA-Z0-9_-], so we encode "server.tool" as
// "server__tool" (double underscore) and decode on the way back.
//
// When the selected provider key is absent the loop short-circuits immediately with a
// mock "done" result so tests can exercise the spawn/get lifecycle without creds.

import { authorize } from "../../kernel/src/capabilities.js";
import { updateAgentState, grantsFor } from "../../control-db/src/registry.js";
import { resolveLlmCredential } from "../../llm/src/providers.js";

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_API_VER = "2023-06-01";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
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

// ---- tool definitions for the Anthropic API ---------------------------------

/** Convert "server.tool" → "server__tool" and back. */
export const encodeName = (server, tool) => `${server}__${tool}`;
export const decodeName = (n) => { const [s, ...t] = n.split("__"); return [s, t.join("__")]; };

/**
 * Build Anthropic tool definitions from the Kernel catalog, filtered to patterns
 * the agent actually holds. Skips tools with no inputSchema.
 */
export function buildToolDefs(allTools, patterns) {
  return allTools
    .filter((t) => {
      const dot = t.name.indexOf(".");
      const server = t.name.slice(0, dot);
      const tool = t.name.slice(dot + 1);
      return !!authorize(patterns, server, tool);
    })
    .map((t) => {
      const dot = t.name.indexOf(".");
      return {
        name: encodeName(t.name.slice(0, dot), t.name.slice(dot + 1)),
        description: t.description ?? t.name,
        input_schema: t.inputSchema ?? { type: "object", properties: {} },
      };
    });
}

export function buildOpenAIToolDefs(allTools, patterns) {
  return allTools
    .filter((t) => {
      const dot = t.name.indexOf(".");
      const server = t.name.slice(0, dot);
      const tool = t.name.slice(dot + 1);
      return !!authorize(patterns, server, tool);
    })
    .map((t) => {
      const dot = t.name.indexOf(".");
      return {
        type: "function",
        function: {
          name: encodeName(t.name.slice(0, dot), t.name.slice(dot + 1)),
          description: t.description ?? t.name,
          parameters: t.inputSchema ?? { type: "object", properties: {} },
        },
      };
    });
}

// ---- Anthropic call ----------------------------------------------------------

async function readJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { error: { message: text || `HTTP ${res.status}` } }; }
}

async function callAnthropic(apiKey, { model, system, tools, messages }) {
  const body = {
    model,
    max_tokens: 4096,
    tools,
    messages,
    ...(system ? { system } : {}),
  };
  const res = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": CLAUDE_API_VER, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok || data.error) throw new Error(data.error?.message ?? `Claude API error (${res.status})`);
  return data;
}

async function callOpenAI(apiKey, { model, tools, messages }) {
  const body = { model, messages, max_tokens: 4096, ...(tools.length ? { tools, tool_choice: "auto" } : {}) };
  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok || data.error) throw new Error(data.error?.message ?? `OpenAI API error (${res.status})`);
  return data;
}

// ---- main runner -------------------------------------------------------------

export async function runAI(agentId, { agentPrincipalId, spawnedBy, patterns, prompt, systemPrompt, kernel, sandbox }) {
  const credential = resolveLlmCredential(sandbox.tenant_id);

  updateAgentState(agentId, "running", { startedAt: Date.now() });

  if (!credential.apiKey) {
    updateAgentState(agentId, "done", {
      result: `(AI agent: ${credential.secretName} not set for ${credential.label} — add it in Profile to enable the AI tool loop)`,
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

  try {
    if (credential.provider === "openai") {
      await runOpenAIToolLoop(agentId, { agentPrincipalId, spawnedBy, patterns, prompt, systemPrompt, kernel, held, credential, budget });
    } else {
      await runClaudeToolLoop(agentId, { agentPrincipalId, spawnedBy, patterns, prompt, systemPrompt, kernel, held, credential, budget });
    }
  } catch (e) {
    updateAgentState(agentId, "failed", { error: e.message, finishedAt: Date.now() });
  }
}

async function runClaudeToolLoop(agentId, { agentPrincipalId, spawnedBy, patterns, prompt, systemPrompt, kernel, held, credential, budget }) {
  const tools = buildToolDefs(kernel.listTools(), patterns);
  const messages = [{ role: "user", content: prompt }];

  for (let iter = 0; iter < MAX_ITER; iter++) {
    if (Date.now() >= budget.deadline) {
      return finalizeBudgetExhausted(agentId, `wall-clock budget exhausted (${budget.maxMs}ms)`, budget.lastText, budget.tokensUsed);
    }

    const resp = await callAnthropic(credential.apiKey, {
      model: credential.modelDefault,
      system: systemPrompt,
      tools,
      messages,
    });
    const usage = resp.usage ?? {};
    budget.tokensUsed += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);

    messages.push({ role: "assistant", content: resp.content });
    const respText = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (respText) budget.lastText = respText;

    if (resp.stop_reason === "end_turn" || !resp.content.some((b) => b.type === "tool_use")) {
      updateAgentState(agentId, "done", { result: respText || "(no text output)", finishedAt: Date.now() });
      return;
    }

    if (budget.tokensUsed >= budget.maxTokens) {
      return finalizeBudgetExhausted(agentId, `token budget exhausted (${budget.tokensUsed}/${budget.maxTokens} tokens)`, budget.lastText, budget.tokensUsed);
    }

    const toolResults = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      const [server, tool] = decodeName(block.name);
      const r = await kernel.call({
        principalId: agentPrincipalId,
        heldPatterns: held,
        server, tool,
        args: block.input ?? {},
        onBehalfOf: spawnedBy,
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: r.ok ? JSON.stringify(r.result) : `Error: ${r.error}`,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }
  updateAgentState(agentId, "failed", { error: `max iterations (${MAX_ITER}) reached`, finishedAt: Date.now() });
}

async function runOpenAIToolLoop(agentId, { agentPrincipalId, spawnedBy, patterns, prompt, systemPrompt, kernel, held, credential, budget }) {
  const tools = buildOpenAIToolDefs(kernel.listTools(), patterns);
  const messages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    { role: "user", content: prompt },
  ];

  for (let iter = 0; iter < MAX_ITER; iter++) {
    if (Date.now() >= budget.deadline) {
      return finalizeBudgetExhausted(agentId, `wall-clock budget exhausted (${budget.maxMs}ms)`, budget.lastText, budget.tokensUsed);
    }

    const resp = await callOpenAI(credential.apiKey, { model: credential.modelDefault, tools, messages });
    const choice = resp.choices?.[0]?.message ?? {};
    const usage = resp.usage ?? {};
    budget.tokensUsed += usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0));

    messages.push(choice);
    const respText = choice.content ?? "";
    if (respText) budget.lastText = respText;

    const toolCalls = choice.tool_calls ?? [];
    if (!toolCalls.length) {
      updateAgentState(agentId, "done", { result: respText || "(no text output)", finishedAt: Date.now() });
      return;
    }

    if (budget.tokensUsed >= budget.maxTokens) {
      return finalizeBudgetExhausted(agentId, `token budget exhausted (${budget.tokensUsed}/${budget.maxTokens} tokens)`, budget.lastText, budget.tokensUsed);
    }

    for (const call of toolCalls) {
      const [server, tool] = decodeName(call.function?.name ?? "");
      let args = {};
      try { args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}; }
      catch { args = {}; }
      const r = await kernel.call({
        principalId: agentPrincipalId,
        heldPatterns: held,
        server, tool,
        args,
        onBehalfOf: spawnedBy,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: r.ok ? JSON.stringify(r.result) : `Error: ${r.error}`,
      });
    }
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
