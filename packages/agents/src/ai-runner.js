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
// When ANTHROPIC_API_KEY is absent the loop short-circuits immediately with a
// mock "done" result so tests can exercise the spawn/get lifecycle without creds.

import { authorize } from "../../kernel/src/capabilities.js";
import { updateAgentState, grantsFor } from "../../control-db/src/registry.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VER = "2023-06-01";
const MAX_ITER = 20;
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

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

// ---- Anthropic call ----------------------------------------------------------

async function callAnthropic(apiKey, { model, system, tools, messages }) {
  const body = {
    model: model ?? DEFAULT_MODEL,
    max_tokens: 4096,
    tools,
    messages,
    ...(system ? { system } : {}),
  };
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": API_VER, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message ?? JSON.stringify(data.error));
  return data;
}

// ---- main runner -------------------------------------------------------------

export async function runAI(agentId, { agentPrincipalId, spawnedBy, patterns, prompt, systemPrompt, kernel, sandbox }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  updateAgentState(agentId, "running", { startedAt: Date.now() });

  if (!apiKey) {
    updateAgentState(agentId, "done", {
      result: "(AI agent: ANTHROPIC_API_KEY not set — set it to enable the AI tool loop)",
      finishedAt: Date.now(),
    });
    return;
  }

  const held = grantsFor(agentPrincipalId, sandbox.id);
  const tools = buildToolDefs(kernel.listTools(), patterns);
  const messages = [{ role: "user", content: prompt }];

  // Budget bounds (backlog #13): capture the wall-clock deadline and token
  // ceiling once at the start of the run. `tokensUsed` accumulates across every
  // iteration; `lastText` holds the most recent assistant text so a budget cut
  // still surfaces whatever partial output the agent produced.
  const maxMs = agentMaxMs();
  const maxTokens = agentMaxTokens();
  const deadline = Date.now() + maxMs;
  let tokensUsed = 0;
  let lastText = "";

  try {
    for (let iter = 0; iter < MAX_ITER; iter++) {
      // Wall-clock guard: stop before issuing another (slow, billable) model
      // call if we are already past the deadline.
      if (Date.now() >= deadline) {
        return finalizeBudgetExhausted(agentId, `wall-clock budget exhausted (${maxMs}ms)`, lastText, tokensUsed);
      }

      const resp = await callAnthropic(apiKey, { model: DEFAULT_MODEL, system: systemPrompt, tools, messages });
      // Token accounting: Anthropic returns input_tokens + output_tokens in
      // usage; sum both so the budget reflects total spend, not just output.
      const usage = resp.usage ?? {};
      tokensUsed += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);

      messages.push({ role: "assistant", content: resp.content });
      const respText = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (respText) lastText = respText;

      if (resp.stop_reason === "end_turn" || !resp.content.some((b) => b.type === "tool_use")) {
        updateAgentState(agentId, "done", { result: respText || "(no text output)", finishedAt: Date.now() });
        return;
      }

      // Token guard: once cumulative spend crosses the ceiling, stop the loop
      // rather than feed tool results back and trigger another model call.
      if (tokensUsed >= maxTokens) {
        return finalizeBudgetExhausted(agentId, `token budget exhausted (${tokensUsed}/${maxTokens} tokens)`, lastText, tokensUsed);
      }

      // Execute each tool_use block via the Kernel.
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
  } catch (e) {
    updateAgentState(agentId, "failed", { error: e.message, finishedAt: Date.now() });
  }
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
