// The four request shapes behind the six providers, in one place.
//
// The `llm` server, the agent runner and the Assistant each make their own calls — one
// is a single completion, one a blocking tool loop, one a streamed conversation — but
// they all have to agree on where a credential's call goes and what its body looks like.
// Three copies of "Gemini on a subscription goes to Cloud Code, wrapped in { model,
// project, request }" is how one of them ends up posting to the wrong host.
//
//   protocol    providers               endpoint
//   anthropic   claude, claude-code     api.anthropic.com/v1/messages
//   chat        openai                  api.openai.com/v1/chat/completions
//   responses   codex                   chatgpt.com/backend-api/codex/responses
//   gemini      gemini, gemini-cli      AI Studio …:generateContent / Cloud Code v1internal:generateContent
//
// Every endpoint is overridable from the environment so tests can point a call at a stub.

import { CODEX_BASE_URL, codexResponsesBody } from "../../ai-auth/src/clients.js";
import {
  CLOUD_CODE_DAILY_BASE_URL, GEMINI_STUDIO_BASE_URL, geminiStudioModelId, isAntigravityUpgradeNotice,
  toCodeAssistRequest,
} from "../../ai-auth/src/gemini.js";

export const CLAUDE_API_URL = () => process.env.SANDBOXOS_ANTHROPIC_URL || "https://api.anthropic.com/v1/messages";
export const OPENAI_API_URL = () => process.env.SANDBOXOS_OPENAI_URL || "https://api.openai.com/v1/chat/completions";
export const CODEX_URL = () => process.env.SANDBOXOS_CODEX_URL || `${CODEX_BASE_URL}/responses`;
export const GEMINI_BASE_URL = () => process.env.SANDBOXOS_GEMINI_URL || GEMINI_STUDIO_BASE_URL;
export const CLOUD_CODE_URL = () => process.env.SANDBOXOS_CLOUD_CODE_URL || CLOUD_CODE_DAILY_BASE_URL;

/** Which request shape a credential's call takes. */
export function protocolOf(credential) {
  if (credential.provider === "codex") return "responses";
  if (credential.wire === "gemini") return "gemini";
  if (credential.wire === "openai") return "chat";
  return "anthropic";
}

/** Where this credential's call for this model goes. */
export function urlFor(credential, model, { stream = false } = {}) {
  switch (protocolOf(credential)) {
    case "responses": return CODEX_URL();
    case "chat": return OPENAI_API_URL();
    case "gemini": {
      const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
      if (credential.provider === "gemini-cli") return `${CLOUD_CODE_URL()}:${method}`;
      return `${GEMINI_BASE_URL()}/models/${encodeURIComponent(geminiStudioModelId(model))}:${method}`;
    }
    default: return CLAUDE_API_URL();
  }
}

// ---- tool names ---------------------------------------------------------------

/**
 * A Kernel tool's name on the wire. Every wire allows [a-zA-Z0-9_-], so "server.tool"
 * becomes "server__tool". On a Claude subscription it additionally takes Claude Code's
 * own MCP namespace, `mcp__server__tool`: subscription requests whose tools are named
 * outside it have been refused as "out of extra usage" with allowance remaining.
 */
export function encodeToolName(credential, server, tool) {
  const base = `${server}__${tool}`;
  return credential?.provider === "claude-code" ? `mcp__${base}` : base;
}

/** The [server, tool] a wire name came from, whichever namespace it was sent in. */
export function decodeToolName(name) {
  const raw = String(name ?? "");
  // Only a three-part name is namespaced: `mcp__x` alone is a server called mcp.
  const n = raw.startsWith("mcp__") && raw.slice(5).includes("__") ? raw.slice(5) : raw;
  const i = n.indexOf("__");
  return i === -1 ? [n, ""] : [n.slice(0, i), n.slice(i + 2)];
}

/**
 * Tool definitions in the credential's shape, from `{ name, description, schema }`.
 * Gemini takes the Anthropic shape here; toCodeAssistRequest turns it into function
 * declarations and sanitizes the schema on the way.
 */
export function shapeTools(credential, tools) {
  switch (protocolOf(credential)) {
    case "chat":
      return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
    case "responses":
      return tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.schema }));
    default:
      return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
  }
}

// ---- Gemini -------------------------------------------------------------------

/**
 * The body for a Gemini call. On a key it is the bare request AI Studio takes; on a
 * subscription it is the Cloud Code envelope around the same request. The catalogue id
 * goes in unchanged either way — toCodeAssistRequest reads the effort tier off it.
 */
export function geminiBody(credential, model, { system, contents, tools = [] }) {
  const envelope = toCodeAssistRequest(model, contents, {
    systemInstruction: system || undefined,
    tools,
    ...(credential.provider === "gemini-cli" && credential.projectId ? { projectId: credential.projectId } : {}),
  });
  return credential.provider === "gemini-cli" ? envelope : envelope.request;
}

let callSeq = 0;

/**
 * One Gemini response (or one streamed frame), reduced. Function calls carry the whole
 * part they came in, because Gemini 3 refuses a call echoed back without the
 * `thoughtSignature` it was issued with.
 */
export function geminiResult(json) {
  const inner = json?.response ?? json ?? {};
  const parts = inner.candidates?.[0]?.content?.parts ?? [];
  let text = "";
  const calls = [];
  for (const part of parts) {
    if (typeof part.text === "string" && !part.thought) text += part.text;
    if (part.functionCall) {
      callSeq += 1;
      calls.push({
        id: `gcall_${Date.now().toString(36)}_${callSeq}`,
        name: part.functionCall.name,
        args: part.functionCall.args ?? {},
        part,
      });
    }
  }
  const um = inner.usageMetadata;
  return {
    text,
    calls,
    parts: parts.filter((p) => !p.thought),
    finishReason: inner.candidates?.[0]?.finishReason ?? null,
    usage: um ? { input: um.promptTokenCount ?? 0, output: um.candidatesTokenCount ?? 0 } : null,
  };
}

/**
 * Google refuses an outdated client with a 200 whose "answer" is an upgrade notice.
 * Passed on as text it reads as the model's reply; it has to be an error.
 */
export function assertNotUpgradeNotice(credential, text) {
  if (credential.provider === "gemini-cli" && isAntigravityUpgradeNotice(text)) {
    throw new Error("Google refused the Antigravity client version this server presents as outdated. "
      + "Set ANTIGRAVITY_CLIENT_VERSION to the current Antigravity release and restart.");
  }
}

/** A tool result going back to Gemini. */
export function geminiToolResult(name, payload) {
  return { functionResponse: { name, response: { result: payload } } };
}

// ---- Codex (Responses API) ----------------------------------------------------

/** The Codex body, from a system prompt and Responses input items. */
export function codexBody(model, { system, input, tools = [] }) {
  return codexResponsesBody({ model, instructions: system, input, tools });
}

/** A user message as a Responses input item. */
export const responsesUser = (text) => ({ role: "user", content: [{ type: "input_text", text }] });
/** Assistant text, echoed back as input (without a server id — nothing was stored). */
export const responsesAssistant = (text) => ({ role: "assistant", content: [{ type: "output_text", text }] });

/** Read an SSE body, yielding parsed `data:` payloads. */
export async function* sseFrames(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data || data === "[DONE]") continue;
        try { yield JSON.parse(data); } catch { /* keepalive or partial frame */ }
      }
    }
    const tail = buffer.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (tail && tail !== "[DONE]") {
      try { yield JSON.parse(tail); } catch { /* partial */ }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * A Codex Responses stream → the Assistant's normalized events. Function calls are taken
 * whole from `response.output_item.done` rather than pieced together from argument
 * deltas: the item carries the call id the result has to name.
 */
export async function* codexEvents(res) {
  for await (const ev of sseFrames(res)) {
    switch (ev.type) {
      case "response.output_text.delta":
        if (ev.delta) yield { type: "text", text: ev.delta };
        break;
      case "response.output_item.done": {
        const item = ev.item ?? {};
        if (item.type === "function_call") {
          yield { type: "tool_start", id: item.call_id, name: item.name };
          yield { type: "tool_args", id: item.call_id, partial: item.arguments ?? "" };
        }
        break;
      }
      case "response.completed": {
        const u = ev.response?.usage;
        if (u) yield { type: "usage", input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
        yield { type: "stop", reason: "completed" };
        break;
      }
      case "response.failed":
      case "response.incomplete":
        throw new Error(ev.response?.error?.message ?? ev.response?.incomplete_details?.reason ?? "Codex response failed");
      case "error":
        throw new Error(ev.message ?? ev.error?.message ?? "Codex stream error");
      default:
        break;
    }
  }
}

/** A whole Codex call, read to the end: its text, its function calls, its usage. */
export async function collectCodex(res) {
  let text = "";
  const calls = new Map();
  const order = [];
  let usage = null;
  for await (const ev of codexEvents(res)) {
    if (ev.type === "text") text += ev.text;
    else if (ev.type === "tool_start") { calls.set(ev.id, { id: ev.id, name: ev.name, args: "" }); order.push(ev.id); }
    else if (ev.type === "tool_args") { const c = calls.get(ev.id); if (c) c.args += ev.partial; }
    else if (ev.type === "usage") usage = { input: ev.input, output: ev.output };
  }
  return { text, calls: order.map((id) => calls.get(id)), usage };
}

/** Gemini's streamed frames → the Assistant's normalized events, plus the raw parts. */
export async function* geminiEvents(res, credential) {
  let usage = null;
  let answered = "";
  for await (const frame of sseFrames(res)) {
    const r = geminiResult(frame);
    if (r.text) {
      if (answered.length < 2000) {
        answered += r.text;
        assertNotUpgradeNotice(credential, answered);
      }
      yield { type: "text", text: r.text };
    }
    for (const c of r.calls) {
      yield { type: "tool_start", id: c.id, name: c.name };
      yield { type: "tool_args", id: c.id, partial: JSON.stringify(c.args ?? {}) };
    }
    for (const part of r.parts) yield { type: "gemini_part", part, callId: r.calls.find((c) => c.part === part)?.id ?? null };
    if (r.usage) usage = r.usage;
    if (r.finishReason) yield { type: "stop", reason: r.finishReason };
  }
  if (usage) yield { type: "usage", input: usage.input, output: usage.output };
}
