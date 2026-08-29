// The Assistant — a conversation that drives the machine.
//
// SandboxOS's premise is that the syscall interface is a tool-calling protocol.
// The Assistant is what that premise looks like from the user's chair: you talk,
// and the model reaches for the same MCP tools you would have typed, through the
// same Kernel, under *your* capabilities, with every call landing in the audit
// log next to the ones you made yourself.
//
// It differs from an `agents.spawn kind=ai` run in three ways that matter:
//   • it streams — text and tool calls appear as they happen, not at the end;
//   • it is a conversation — turns accumulate and persist;
//   • it is interruptible — an AbortSignal stops the loop mid-turn.
//
// Authority: the Assistant runs as the calling principal with the caller's own
// held patterns. It is not a delegation, so it cannot exceed you, and it does
// not need a minted token.

import { authorize } from "../../kernel/src/capabilities.js";
import {
  baseUrlFor, credentialHeaders, resolveLlmCredential, systemFor,
} from "../../llm/src/providers.js";
import { CODEX_BASE_URL } from "../../ai-auth/src/clients.js";
import { describeProviderError } from "../../ai-auth/src/errors.js";
import { anthropicEvents, openaiEvents } from "./stream.js";

// Endpoints are read lazily and overridable so the turn loop can be pointed at a
// stub provider in tests without mocking fetch itself.
const CLAUDE_API_URL = () => process.env.SANDBOXOS_ANTHROPIC_URL || "https://api.anthropic.com/v1/messages";
const OPENAI_API_URL = () => process.env.SANDBOXOS_OPENAI_URL || "https://api.openai.com/v1/chat/completions";
const CODEX_URL = () => process.env.SANDBOXOS_CODEX_URL || `${CODEX_BASE_URL}/chat/completions`;

/** How many model→tools→model round trips one turn may take. */
const MAX_STEPS = () => Number(process.env.SANDBOXOS_ASSISTANT_MAX_STEPS ?? 12);
/** Wall-clock ceiling for one turn. */
const MAX_MS = () => Number(process.env.SANDBOXOS_ASSISTANT_MAX_MS ?? 5 * 60_000);
/** Token ceiling for one turn, summed across steps. */
const MAX_TOKENS = () => Number(process.env.SANDBOXOS_ASSISTANT_MAX_TOKENS ?? 200_000);
/** A tool result longer than this is truncated before going back to the model. */
const MAX_RESULT_CHARS = 20_000;

/** Anthropic tool names allow [a-zA-Z0-9_-], so "server.tool" is encoded. */
export const encodeName = (server, tool) => `${server}__${tool}`;
export const decodeName = (n) => {
  const i = n.indexOf("__");
  return i === -1 ? [n, ""] : [n.slice(0, i), n.slice(i + 2)];
};

export function systemPrompt(sandbox, servers) {
  return [
    `You are the assistant inside SandboxOS, running on the Sandbox "${sandbox.slug}".`,
    "",
    "This machine's entire system-call interface is MCP tools, and you hold the same",
    "capabilities as the person you are talking to — no more. Use the tools to look",
    "before you answer: read the file, list the directory, run the command. Do not",
    "guess at the contents of the machine when you can check.",
    "",
    `Enabled servers: ${servers.join(", ")}.`,
    "",
    "Conventions that matter here:",
    "- Paths are relative to the Sandbox root. An absolute path means this machine's root.",
    "- proc.exec runs a command to completion; proc.start supervises a long-running one",
    "  (a dev server, a watcher) and proc.logs tails it.",
    "- A service running inside the Cell is only reachable once ports.expose declares it.",
    "- Secrets are references, never values. Use secrets.useInEnv to run a command with one.",
    "",
    "Be concise. Report what you actually did and what the machine actually said.",
    "When a tool fails, say so plainly and either fix it or explain what is blocking.",
  ].join("\n");
}

/**
 * Tool definitions for the tools these patterns actually authorize.
 *
 * Keyed on the *wire*, not the provider: a Codex subscription and an OpenAI key speak
 * the same tool shape even though they bill entirely differently. Passing "claude" or
 * "anthropic" both select the Anthropic shape.
 */
export function toolDefs(allTools, patterns, wire) {
  const allowed = allTools.filter((t) => {
    const dot = t.name.indexOf(".");
    return !!authorize(patterns, t.name.slice(0, dot), t.name.slice(dot + 1));
  });
  return allowed.map((t) => {
    const dot = t.name.indexOf(".");
    const name = encodeName(t.name.slice(0, dot), t.name.slice(dot + 1));
    const schema = t.inputSchema ?? { type: "object", properties: {} };
    return wire === "openai"
      ? { type: "function", function: { name, description: t.description ?? t.name, parameters: schema } }
      : { name, description: t.description ?? t.name, input_schema: schema };
  });
}

/** Truncate a tool result so one `cat` of a big file cannot blow the context. */
function clip(text) {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n… [truncated ${text.length - MAX_RESULT_CHARS} characters]`;
}

/**
 * The most useful sentence available for a failed provider response.
 *
 * The headers are carried onto the shaped error along with the status, because a 429
 * that reports the plan as still allowed means a per-model limit — "switch to a lighter
 * model" — while one that does not means the allowance is genuinely spent. Same status,
 * opposite remedies, and the difference is only in the headers.
 */
async function providerError(res, credential, model) {
  const text = await res.text().catch(() => "");
  let msg = `${res.status} ${res.statusText}`;
  try { msg = JSON.parse(text)?.error?.message ?? msg; } catch { if (text) msg = text.slice(0, 300); }
  const shaped = { status: res.status, message: JSON.stringify({ message: msg }), headers: res.headers };
  const described = credential
    ? describeProviderError(shaped, credential.provider, model, { configureAt: "Settings" })
    : null;
  return new Error(described ?? msg);
}

/**
 * Run one assistant turn.
 *
 * @param {object}   o
 * @param {object}   o.kernel        the Sandbox's Kernel
 * @param {object}   o.sandbox       the Sandbox row
 * @param {string}   o.principalId   who is asking (the Assistant acts as them)
 * @param {string[]} o.heldPatterns  their capability patterns
 * @param {object[]} o.history       prior turns in provider-neutral form
 * @param {string}   o.input         the new user message
 * @param {Function} o.emit          called with each normalized event
 * @param {AbortSignal} [o.signal]   abort to stop mid-turn
 * @returns {Promise<{messages: object[], stopped: string}>} the appended turns
 */
export async function runTurn({ kernel, sandbox, principalId, heldPatterns, history = [], input, emit, signal, model }) {
  const credential = await resolveLlmCredential(sandbox.tenant_id);
  if (!credential.configured) {
    emit({ type: "error", error: credential.error });
    return { messages: [], stopped: "no_credential" };
  }

  const servers = [...kernel.servers.keys()];
  const defs = toolDefs(kernel.listTools(), heldPatterns, credential.wire);
  const maxSteps = MAX_STEPS();
  const deadline = Date.now() + MAX_MS();
  const maxTokens = MAX_TOKENS();
  let tokens = 0;

  // The transcript we hand back to the caller to persist, in provider shape.
  const appended = [];
  const messages = [...history];
  messages.push(credential.wire === "openai"
    ? { role: "user", content: input }
    : { role: "user", content: [{ type: "text", text: input }] });
  appended.push(messages.at(-1));

  emit({ type: "turn_start", provider: credential.provider, model: model ?? credential.modelDefault, tools: defs.length });

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) { emit({ type: "stopped", reason: "cancelled" }); return { messages: appended, stopped: "cancelled" }; }
    if (Date.now() > deadline) { emit({ type: "stopped", reason: "time_budget" }); return { messages: appended, stopped: "time_budget" }; }
    if (tokens > maxTokens) { emit({ type: "stopped", reason: "token_budget" }); return { messages: appended, stopped: "token_budget" }; }

    emit({ type: "step", step: step + 1 });

    // ── Ask the model, streaming ────────────────────────────────────────────
    const isOpenAI = credential.wire === "openai";
    const chosen = model ?? credential.modelDefault;
    const url = baseUrlFor(credential, CLAUDE_API_URL(), OPENAI_API_URL(), CODEX_URL());
    const headers = credentialHeaders(credential);
    const body = isOpenAI
      ? {
          model: chosen,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "system", content: systemPrompt(sandbox, servers) }, ...messages],
          ...(defs.length ? { tools: defs, tool_choice: "auto" } : {}),
        }
      : {
          model: chosen,
          max_tokens: 4096,
          stream: true,
          // On a subscription token the Claude Code identity block has to come first
          // and stand alone, or Sonnet and Opus are refused with a 429 the plan has
          // not earned. systemFor is what puts it there.
          system: systemFor(credential, systemPrompt(sandbox, servers)),
          messages,
          ...(defs.length ? { tools: defs } : {}),
        };

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) throw await providerError(res, credential, chosen);

    let text = "";
    let stopReason = null;
    /** id → { id, name, args } accumulated across delta frames. */
    const calls = new Map();
    const order = [];

    for await (const ev of (isOpenAI ? openaiEvents(res) : anthropicEvents(res))) {
      if (signal?.aborted) break;
      switch (ev.type) {
        case "text":
          text += ev.text;
          emit({ type: "text", text: ev.text });
          break;
        case "tool_start":
          calls.set(ev.id, { id: ev.id, name: ev.name, args: "" });
          order.push(ev.id);
          emit({ type: "tool_start", id: ev.id, name: ev.name.replace("__", ".") });
          break;
        case "tool_args": {
          const c = calls.get(ev.id);
          if (c) c.args += ev.partial;
          break;
        }
        case "usage":
          tokens += (ev.input ?? 0) + (ev.output ?? 0);
          break;
        case "stop":
          stopReason = ev.reason;
          break;
        default:
          break;
      }
    }

    if (signal?.aborted) { emit({ type: "stopped", reason: "cancelled" }); return { messages: appended, stopped: "cancelled" }; }

    // ── Record the assistant turn in provider shape ─────────────────────────
    const parsed = order.map((id) => {
      const c = calls.get(id);
      let args = {};
      try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = { _unparsed: c.args }; }
      return { ...c, parsedArgs: args };
    });

    if (isOpenAI) {
      messages.push({
        role: "assistant",
        content: text || null,
        ...(parsed.length
          ? { tool_calls: parsed.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })) }
          : {}),
      });
    } else {
      const content = [];
      if (text) content.push({ type: "text", text });
      for (const c of parsed) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.parsedArgs });
      messages.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] });
    }
    appended.push(messages.at(-1));

    // ── No tools requested: the turn is over ────────────────────────────────
    if (!parsed.length) {
      emit({ type: "done", stopReason: stopReason ?? "end_turn", tokens, steps: step + 1 });
      return { messages: appended, stopped: "end_turn" };
    }

    // ── Run the tools through the Kernel ────────────────────────────────────
    const results = [];
    for (const c of parsed) {
      const [server, tool] = decodeName(c.name);
      emit({ type: "tool_call", id: c.id, server, tool, args: c.parsedArgs });
      const r = await kernel.call({
        principalId, heldPatterns, server, tool, args: c.parsedArgs,
      });
      const payload = r.ok ? clip(JSON.stringify(r.result)) : `Error: ${r.error}`;
      emit({ type: "tool_result", id: c.id, ok: !!r.ok, server, tool, result: r.ok ? r.result : null, error: r.ok ? null : r.error });
      results.push({ id: c.id, payload });
    }

    if (isOpenAI) {
      for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.payload });
      appended.push(...messages.slice(-results.length));
    } else {
      messages.push({
        role: "user",
        content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.payload })),
      });
      appended.push(messages.at(-1));
    }
  }

  emit({ type: "stopped", reason: "max_steps", steps: maxSteps });
  return { messages: appended, stopped: "max_steps" };
}

/** Flatten a provider-shaped transcript into what a UI wants to render. */
export function renderTranscript(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "tool") {
      // OpenAI tool results are a role of their own; handled below so they are
      // not also emitted as plain text.
      out.push({ role: "tool", kind: "tool_result", id: m.tool_call_id, text: String(m.content ?? "") });
      continue;
    }
    if (typeof m.content === "string") {
      if (m.content) out.push({ role: m.role, kind: "text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "text" && block.text) out.push({ role: m.role, kind: "text", text: block.text });
        else if (block.type === "tool_use") out.push({ role: "assistant", kind: "tool_call", id: block.id, name: block.name.replace("__", "."), args: block.input });
        else if (block.type === "tool_result") out.push({ role: "tool", kind: "tool_result", id: block.tool_use_id, text: String(block.content ?? "") });
      }
    }
    if (m.role === "assistant" && m.tool_calls) {
      for (const c of m.tool_calls) {
        out.push({ role: "assistant", kind: "tool_call", id: c.id, name: (c.function?.name ?? "").replace("__", "."), args: safeParse(c.function?.arguments) });
      }
    }
  }
  return out;
}

function safeParse(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}
