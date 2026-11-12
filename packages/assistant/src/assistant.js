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
import { hasOs, loadOs, summarizeDoc, READ_ONLY_DESKTOP_TOOLS } from "../../os/src/index.js";
import { credentialHeaders, resolveLlmCredential, systemFor } from "../../llm/src/providers.js";
// Endpoints live in wires.js, read lazily and overridable from the environment, so the
// turn loop can be pointed at a stub provider in tests without mocking fetch itself.
import {
  codexBody, codexEvents, decodeToolName, encodeToolName, geminiBody, geminiEvents, geminiToolResult,
  protocolOf, responsesAssistant, responsesUser, shapeTools, urlFor,
} from "../../llm/src/wires.js";
import { describeProviderError } from "../../ai-auth/src/errors.js";
import { anthropicEvents, openaiEvents } from "./stream.js";

/** How many model→tools→model round trips one turn may take. */
const MAX_STEPS = () => Number(process.env.SANDBOXOS_ASSISTANT_MAX_STEPS ?? 12);
/** Wall-clock ceiling for one turn. */
const MAX_MS = () => Number(process.env.SANDBOXOS_ASSISTANT_MAX_MS ?? 5 * 60_000);
/** Token ceiling for one turn, summed across steps. */
const MAX_TOKENS = () => Number(process.env.SANDBOXOS_ASSISTANT_MAX_TOKENS ?? 200_000);
/** A tool result longer than this is truncated before going back to the model. */
const MAX_RESULT_CHARS = 20_000;

/** Tool names allow [a-zA-Z0-9_-], so "server.tool" is encoded (see wires.js). */
export const encodeName = (server, tool, credential = null) => encodeToolName(credential, server, tool);
export const decodeName = (n) => decodeToolName(n);

/** The desktop map, when this machine has a desktop and the caller may see it. */
function desktopContext(sandbox, servers, heldPatterns) {
  if (!servers.includes("desktop") || !hasOs(sandbox)) return [];
  if (!authorize(heldPatterns ?? [], "desktop", "state")) return [];
  try {
    const d = loadOs(sandbox);
    return [
      "",
      "The desktop (desktop.* tools change it; the map below is the current document —",
      "call desktop.summarize for a fresh one after you change things):",
      summarizeDoc(d),
    ];
  } catch { return []; }
}

export function systemPrompt(sandbox, servers, heldPatterns = null, { propose = false } = {}) {
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
    // Review mode is stated whether or not this machine has a desktop yet: a model
    // that thinks its writes landed will report work nobody has approved.
    ...(propose ? [
      "",
      "REVIEW MODE IS ON. Your desktop.* changes are not applied — they are queued as a",
      "proposal for the person to apply or discard. Reads work normally. Say what you",
      "proposed and why; never claim the desktop has changed.",
    ] : []),
    ...desktopContext(sandbox, servers, heldPatterns),
  ].join("\n");
}

/**
 * Tool definitions for the tools these patterns actually authorize.
 *
 * Keyed on the *protocol*, not the provider: a ChatGPT-via-Codex subscription speaks
 * the Responses shape, an OpenAI key the chat-completions shape, and Gemini takes the
 * Anthropic shape here (toCodeAssistRequest converts it). Pass a resolved credential
 * to get that right — and the `mcp__` names a Claude subscription needs — or a wire
 * name ("claude"/"anthropic", "openai", "responses", "gemini").
 */
export function toolDefs(allTools, patterns, wireOrCredential) {
  const credential = typeof wireOrCredential === "object" && wireOrCredential
    ? wireOrCredential
    : wireOrCredential === "responses" ? { provider: "codex", wire: "openai" }
      : wireOrCredential === "openai" ? { provider: "openai", wire: "openai" }
        : wireOrCredential === "gemini" ? { provider: "gemini", wire: "gemini" }
          : { provider: "claude", wire: "anthropic" };
  const allowed = allTools.filter((t) => {
    const dot = t.name.indexOf(".");
    return !!authorize(patterns, t.name.slice(0, dot), t.name.slice(dot + 1));
  });
  return shapeTools(credential, allowed.map((t) => {
    const dot = t.name.indexOf(".");
    return {
      name: encodeName(t.name.slice(0, dot), t.name.slice(dot + 1), credential),
      description: t.description ?? t.name,
      schema: t.inputSchema ?? { type: "object", properties: {} },
    };
  }));
}

// ---- history across protocols -----------------------------------------------
//
// A conversation is persisted in the shape of whichever provider answered it, and the
// model picker makes switching provider mid-conversation an ordinary thing to do. A
// Claude transcript sent to Gemini is a 400, so turns in another protocol's shape are
// carried over as their text — the tool calls inside them were the other model's, and
// cannot be replayed to this one anyway.

function shapeOf(m) {
  if (Array.isArray(m?.parts)) return "gemini";
  if (m?.type === "function_call" || m?.type === "function_call_output") return "responses";
  if (m?.role === "tool" || m?.tool_calls) return "chat";
  if (Array.isArray(m?.content)) {
    if (m.content.some((b) => b?.type === "input_text" || b?.type === "output_text")) return "responses";
    return "anthropic";
  }
  return "any";
}

function textOf(m) {
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) {
    return m.content.filter((b) => typeof b?.text === "string" && b.type !== "tool_result").map((b) => b.text).join("\n");
  }
  if (Array.isArray(m?.parts)) return m.parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
  return "";
}

function userMessage(protocol, text) {
  switch (protocol) {
    case "chat": return { role: "user", content: text };
    case "responses": return responsesUser(text);
    case "gemini": return { role: "user", parts: [{ text }] };
    default: return { role: "user", content: [{ type: "text", text }] };
  }
}

function assistantText(protocol, text) {
  switch (protocol) {
    case "chat": return { role: "assistant", content: text };
    case "responses": return responsesAssistant(text);
    case "gemini": return { role: "model", parts: [{ text }] };
    default: return { role: "assistant", content: [{ type: "text", text }] };
  }
}

/** The history in this protocol's shape, with foreign turns reduced to their text. */
export function adaptHistory(history, protocol) {
  const out = [];
  for (const m of history ?? []) {
    const shape = shapeOf(m);
    if (shape === protocol || (shape === "any" && protocol !== "gemini")) { out.push(m); continue; }
    if (m?.role === "tool" || m?.type) continue; // another model's tool traffic
    const text = textOf(m).trim();
    if (!text) continue;
    const assistant = m.role === "assistant" || m.role === "model";
    out.push(assistant ? assistantText(protocol, text) : userMessage(protocol, text));
  }
  return out;
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
export async function runTurn({ kernel, sandbox, principalId, heldPatterns, history = [], input, emit, signal, model, propose = false }) {
  // The model: this request's own, else the tenant's saved choice, else the catalogue default.
  const credential = await resolveLlmCredential(sandbox.tenant_id, null, { model });
  if (!credential.configured) {
    emit({ type: "error", error: credential.error });
    return { messages: [], stopped: "no_credential" };
  }

  const chosen = credential.model;
  const protocol = protocolOf(credential);
  const proposed = [];   // review mode: the desktop changes the model asked for
  // What this turn cost, in the only unit we can count honestly. The caller
  // records it; a price depends on a plan we may not be able to see (T3.5).
  const usage = { provider: credential.provider, model: chosen, tokens: 0 };
  const servers = [...kernel.servers.keys()];
  const defs = toolDefs(kernel.listTools(), heldPatterns, credential);
  const maxSteps = MAX_STEPS();
  const deadline = Date.now() + MAX_MS();
  const maxTokens = MAX_TOKENS();
  let tokens = 0;

  // The transcript we hand back to the caller to persist, in provider shape.
  const appended = [];
  const messages = adaptHistory(history, protocol);
  messages.push(userMessage(protocol, input));
  appended.push(messages.at(-1));

  /** Write the turn's captured desktop changes as one proposal, once. */
  async function flushProposal() {
    if (!proposed.length) return;
    const ops = proposed.splice(0);
    const r = await kernel.call({
      principalId, heldPatterns, server: "desktop", tool: "propose",
      args: { label: String(input).trim().slice(0, 90) || "proposed change", ops },
    });
    emit(r.ok
      ? { type: "proposal", proposal: r.result.proposal, ops: ops.length }
      : { type: "error", error: `could not queue the proposal: ${r.error}` });
  }

  emit({ type: "turn_start", provider: credential.provider, model: chosen, tools: defs.length, propose });

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) { await flushProposal(); emit({ type: "stopped", reason: "cancelled" }); return { messages: appended, stopped: "cancelled", usage }; }
    if (Date.now() > deadline) { emit({ type: "stopped", reason: "time_budget" }); return { messages: appended, stopped: "time_budget" }; }
    if (tokens > maxTokens) { emit({ type: "stopped", reason: "token_budget" }); return { messages: appended, stopped: "token_budget", usage }; }

    emit({ type: "step", step: step + 1 });

    // ── Ask the model, streaming ────────────────────────────────────────────
    const system = systemPrompt(sandbox, servers, heldPatterns, { propose });
    const url = urlFor(credential, chosen, { stream: true });
    const headers = credentialHeaders(credential);
    let body;
    if (protocol === "chat") {
      body = {
        model: chosen,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "system", content: system }, ...messages],
        ...(defs.length ? { tools: defs, tool_choice: "auto" } : {}),
      };
    } else if (protocol === "responses") {
      body = codexBody(chosen, { system, input: messages, tools: defs });
    } else if (protocol === "gemini") {
      body = geminiBody(credential, chosen, { system, contents: messages, tools: defs });
    } else {
      // No temperature, no `thinking`, no forced tool_choice, no prefill: each is a 400
      // on the 5.x models. On a subscription token the Claude Code identity block has to
      // come first and stand alone, or Sonnet and Opus are refused with a 429 the plan
      // has not earned. systemFor is what puts it there.
      body = {
        model: chosen,
        max_tokens: 4096,
        stream: true,
        system: systemFor(credential, system),
        messages,
        ...(defs.length ? { tools: defs } : {}),
      };
    }

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) throw await providerError(res, credential, chosen);

    let text = "";
    let stopReason = null;
    /** id → { id, name, args } accumulated across delta frames. */
    const calls = new Map();
    const order = [];
    /** Gemini only: the model's parts, kept whole for their thought signatures. */
    const modelParts = [];

    const events = protocol === "chat" ? openaiEvents(res)
      : protocol === "responses" ? codexEvents(res)
        : protocol === "gemini" ? geminiEvents(res, credential)
          : anthropicEvents(res);
    for await (const ev of events) {
      if (signal?.aborted) break;
      switch (ev.type) {
        case "text":
          text += ev.text;
          emit({ type: "text", text: ev.text });
          break;
        case "tool_start":
          calls.set(ev.id, { id: ev.id, name: ev.name, args: "" });
          order.push(ev.id);
          emit({ type: "tool_start", id: ev.id, name: decodeName(ev.name).join(".") });
          break;
        case "tool_args": {
          const c = calls.get(ev.id);
          if (c) c.args += ev.partial;
          break;
        }
        case "gemini_part":
          modelParts.push(ev.part);
          break;
        case "usage":
          tokens += (ev.input ?? 0) + (ev.output ?? 0);
          usage.tokens = tokens;
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

    // A turn with neither text nor tool calls is not recorded: an empty assistant
    // message is refused by every one of these APIs on the *next* turn.
    const before = messages.length;
    if (protocol === "chat") {
      if (text || parsed.length) {
        messages.push({
          role: "assistant",
          content: text || null,
          ...(parsed.length
            ? { tool_calls: parsed.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })) }
            : {}),
        });
      }
    } else if (protocol === "responses") {
      if (text) messages.push(responsesAssistant(text));
      for (const c of parsed) messages.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.args || "{}" });
    } else if (protocol === "gemini") {
      if (modelParts.length) messages.push({ role: "model", parts: modelParts });
    } else {
      const content = [];
      if (text) content.push({ type: "text", text });
      for (const c of parsed) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.parsedArgs });
      if (content.length) messages.push({ role: "assistant", content });
    }
    appended.push(...messages.slice(before));

    // ── No tools requested: the turn is over ────────────────────────────────
    if (!parsed.length) {
      await flushProposal();
      emit({ type: "done", stopReason: stopReason ?? "end_turn", tokens, steps: step + 1 });
      return { messages: appended, stopped: "end_turn", usage };
    }

    // ── Run the tools through the Kernel ────────────────────────────────────
    const results = [];
    for (const c of parsed) {
      const [server, tool] = decodeName(c.name);
      emit({ type: "tool_call", id: c.id, server, tool, args: c.parsedArgs });

      // Review mode: a change to the desktop is captured for a human to read
      // rather than made (goal.md T2.3). Reads go through — an agent that cannot
      // look at the desktop cannot propose anything sensible about it — and
      // everything on other servers is unaffected: this is about the *desk*, not
      // about withholding capabilities the caller granted.
      if (propose && server === "desktop" && !READ_ONLY_DESKTOP_TOOLS.has(tool)) {
        proposed.push({ tool, args: c.parsedArgs ?? {} });
        const payload = clip(JSON.stringify({
          proposed: true, tool: `desktop.${tool}`,
          note: "Review mode is on: this change is queued for the person to apply or discard. Carry on as if it had been made, and say what you proposed.",
        }));
        emit({ type: "tool_result", id: c.id, ok: true, server, tool, result: { proposed: true }, error: null });
        results.push({ id: c.id, name: c.name, payload });
        continue;
      }

      const r = await kernel.call({
        principalId, heldPatterns, server, tool, args: c.parsedArgs,
      });
      const payload = r.ok ? clip(JSON.stringify(r.result)) : `Error: ${r.error}`;
      emit({ type: "tool_result", id: c.id, ok: !!r.ok, server, tool, result: r.ok ? r.result : null, error: r.ok ? null : r.error });
      results.push({ id: c.id, name: c.name, payload });
    }

    const resultsAt = messages.length;
    if (protocol === "chat") {
      for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.payload });
    } else if (protocol === "responses") {
      for (const r of results) messages.push({ type: "function_call_output", call_id: r.id, output: r.payload });
    } else if (protocol === "gemini") {
      messages.push({ role: "user", parts: results.map((r) => geminiToolResult(r.name, r.payload)) });
    } else {
      messages.push({
        role: "user",
        content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.payload })),
      });
    }
    appended.push(...messages.slice(resultsAt));
  }

  await flushProposal();
  emit({ type: "stopped", reason: "max_steps", steps: maxSteps });
  return { messages: appended, stopped: "max_steps", usage };
}

/** Flatten a provider-shaped transcript into what a UI wants to render. */
export function renderTranscript(messages) {
  const out = [];
  const toolName = (n) => decodeName(n ?? "").join(".");
  for (const m of messages) {
    // The Responses API's items (Codex).
    if (m.type === "function_call") {
      out.push({ role: "assistant", kind: "tool_call", id: m.call_id, name: toolName(m.name), args: safeParse(m.arguments) });
      continue;
    }
    if (m.type === "function_call_output") {
      out.push({ role: "tool", kind: "tool_result", id: m.call_id, text: String(m.output ?? "") });
      continue;
    }
    // Gemini's parts.
    if (Array.isArray(m.parts)) {
      const role = m.role === "model" ? "assistant" : "user";
      for (const part of m.parts) {
        if (typeof part.text === "string" && part.text && !part.thought) out.push({ role, kind: "text", text: part.text });
        else if (part.functionCall) out.push({ role: "assistant", kind: "tool_call", id: null, name: toolName(part.functionCall.name), args: part.functionCall.args ?? {} });
        else if (part.functionResponse) {
          const r = part.functionResponse.response?.result;
          out.push({ role: "tool", kind: "tool_result", id: null, text: typeof r === "string" ? r : JSON.stringify(r ?? "") });
        }
      }
      continue;
    }
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
        if ((block.type === "text" || block.type === "input_text" || block.type === "output_text") && block.text) out.push({ role: m.role, kind: "text", text: block.text });
        else if (block.type === "tool_use") out.push({ role: "assistant", kind: "tool_call", id: block.id, name: toolName(block.name), args: block.input });
        else if (block.type === "tool_result") out.push({ role: "tool", kind: "tool_result", id: block.tool_use_id, text: String(block.content ?? "") });
      }
    }
    if (m.role === "assistant" && m.tool_calls) {
      for (const c of m.tool_calls) {
        out.push({ role: "assistant", kind: "tool_call", id: c.id, name: toolName(c.function?.name), args: safeParse(c.function?.arguments) });
      }
    }
  }
  return out;
}

function safeParse(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}
