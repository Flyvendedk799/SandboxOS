// Phase 22: the Assistant.
//
// A conversation that drives the machine. The parts worth pinning down are the
// turn loop (does it stream, does it route tool calls through the Kernel, does
// it stop when told), the capability boundary (it acts as *you*, so it can never
// exceed you), and persistence (a reload shows what happened).
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import {
  ensureSeed, grantsFor, queryAudit,
  createConversation, listConversations, conversationMessages,
  appendConversationMessages, deleteConversation, renameConversation,
  createPrincipal, updateTenantProfile,
} from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { runTurn, toolDefs, renderTranscript, decodeName } from "../packages/assistant/src/assistant.js";
import { createServer } from "../apps/gateway/src/server.js";
import { stubProvider } from "./fixtures/stub-provider.js";

let kernel, owner, sandbox, held, server, base, cookie;

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  // A tenant key must exist for the loop to start; the stub never checks it.
  process.env.ANTHROPIC_API_KEY = "test-key";
  server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + "/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  cookie = r.headers.getSetCookie()[0].split(";")[0];
});
test.after(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SANDBOXOS_ANTHROPIC_URL;
  delete process.env.SANDBOXOS_OPENAI_URL;
  server.close();
  _resetKernels();
  closeDb();
});

/** Run one turn against a scripted provider, collecting every emitted event. */
async function turnWith(script, { input, flavor = "anthropic", signal, history = [] } = {}) {
  const stub = stubProvider(script, { flavor });
  const url = await stub.listen();
  if (flavor === "openai") process.env.SANDBOXOS_OPENAI_URL = url;
  else process.env.SANDBOXOS_ANTHROPIC_URL = url;
  const events = [];
  try {
    const out = await runTurn({
      kernel, sandbox, principalId: owner.id, heldPatterns: held,
      history, input, emit: (e) => events.push(e), signal,
    });
    return { events, out, stub };
  } finally {
    stub.close();
  }
}

// ── Streaming ────────────────────────────────────────────────────────────────

test("assistant text arrives as a stream of deltas, not one lump", async () => {
  const { events } = await turnWith([{ text: "Here is what I found in your sandbox." }],
    { input: "what is here?" });
  const chunks = events.filter((e) => e.type === "text");
  assert.ok(chunks.length > 1, "the text should arrive in several deltas");
  assert.equal(chunks.map((c) => c.text).join(""), "Here is what I found in your sandbox.");
  assert.ok(events.some((e) => e.type === "done"));
});

test("a turn reports the provider, model and how many tools it was offered", async () => {
  const { events } = await turnWith([{ text: "ok" }], { input: "hi" });
  const start = events.find((e) => e.type === "turn_start");
  assert.equal(start.provider, "claude");
  assert.ok(start.tools > 10, "the whole authorized catalogue should be offered");
});

// ── Tool use ─────────────────────────────────────────────────────────────────

test("a tool call runs through the Kernel and really changes the machine", async () => {
  const { events } = await turnWith([
    { tools: [{ name: "fs__write", args: { path: "p22/from-assistant.txt", content: "written by the assistant" } }] },
    { text: "Done — I wrote the file." },
  ], { input: "write a file" });

  const started = events.find((e) => e.type === "tool_start");
  assert.equal(started.name, "fs.write");
  const called = events.find((e) => e.type === "tool_call");
  assert.equal(called.server, "fs");
  assert.equal(called.tool, "write");
  assert.equal(called.args.path, "p22/from-assistant.txt");
  const result = events.find((e) => e.type === "tool_result");
  assert.equal(result.ok, true);

  const read = await kernel.call({
    principalId: owner.id, heldPatterns: held, server: "fs", tool: "read",
    args: { path: "p22/from-assistant.txt" },
  });
  assert.equal(read.result.content, "written by the assistant");
});

test("the assistant's tool calls land in the audit log like any other call", async () => {
  const events = queryAudit(sandbox.id, { server: "fs", tool: "write", limit: 50 });
  assert.ok(events.some((e) => (e.args_json ?? "").includes("p22/from-assistant.txt")));
});

test("a failing tool is reported, not swallowed, and the turn continues", async () => {
  const { events, out } = await turnWith([
    { tools: [{ name: "fs__read", args: { path: "p22/does-not-exist.txt" } }] },
    { text: "That file is not there." },
  ], { input: "read a missing file" });

  const result = events.find((e) => e.type === "tool_result");
  assert.equal(result.ok, false);
  assert.ok(result.error, "the error text must reach the UI");
  assert.equal(out.stopped, "end_turn", "a tool failure is not a turn failure");
});

test("several tool calls in one step all run, in order", async () => {
  const { events } = await turnWith([
    { tools: [
      { name: "fs__write", args: { path: "p22/a.txt", content: "a" } },
      { name: "fs__write", args: { path: "p22/b.txt", content: "b" } },
    ] },
    { text: "Both written." },
  ], { input: "write two files" });

  const calls = events.filter((e) => e.type === "tool_call");
  assert.deepEqual(calls.map((c) => c.args.path), ["p22/a.txt", "p22/b.txt"]);
  assert.equal(events.filter((e) => e.type === "tool_result" && e.ok).length, 2);
});

// ── The capability boundary ──────────────────────────────────────────────────

test("the assistant is only offered tools the caller actually holds", () => {
  const all = kernel.listTools();
  const narrow = toolDefs(all, ["fs.read"], "claude").map((d) => d.name);
  assert.deepEqual(narrow, ["fs__read"]);
  assert.ok(toolDefs(all, ["fs.*"], "claude").length > 5);
  assert.ok(toolDefs(all, [], "claude").length === 0, "no grants means no tools");
});

test("a tool the caller cannot use is denied by the Kernel even if the model asks", async () => {
  const events = [];
  const stub = stubProvider([
    { tools: [{ name: "proc__exec", args: { cmd: "echo nope" } }] },
    { text: "I could not run that." },
  ]);
  process.env.SANDBOXOS_ANTHROPIC_URL = await stub.listen();
  try {
    // A caller holding only fs.read — the same shape as an attenuated token.
    await runTurn({
      kernel, sandbox, principalId: owner.id, heldPatterns: ["fs.read"],
      input: "run a command", emit: (e) => events.push(e),
    });
  } finally { stub.close(); }

  const result = events.find((e) => e.type === "tool_result");
  assert.equal(result.ok, false);
  assert.match(result.error, /denied/);
});

test("OpenAI tool definitions use the function shape", () => {
  const defs = toolDefs(kernel.listTools(), ["fs.read"], "openai");
  assert.equal(defs[0].type, "function");
  assert.equal(defs[0].function.name, "fs__read");
  assert.ok(defs[0].function.parameters);
});

// ── The OpenAI wire format ───────────────────────────────────────────────────

test("the same turn loop works against the OpenAI stream format", async () => {
  updateTenantProfile(sandbox.tenant_id, { llmProvider: "openai" });
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const { events, out } = await turnWith([
      { tools: [{ name: "fs__write", args: { path: "p22/openai.txt", content: "hi" } }] },
      { text: "Wrote it." },
    ], { input: "write a file", flavor: "openai" });

    assert.equal(events.find((e) => e.type === "turn_start").provider, "openai");
    const call = events.find((e) => e.type === "tool_call");
    assert.equal(call.server, "fs");
    assert.equal(call.args.path, "p22/openai.txt");
    assert.equal(events.find((e) => e.type === "tool_result").ok, true);
    assert.equal(events.filter((e) => e.type === "text").map((e) => e.text).join(""), "Wrote it.");
    assert.equal(out.stopped, "end_turn");

    // The stored turn must be in OpenAI shape so the next turn replays correctly.
    const assistantMsg = out.messages.find((m) => m.role === "assistant" && m.tool_calls);
    assert.ok(assistantMsg, "the tool call is recorded as OpenAI tool_calls");
    assert.ok(out.messages.some((m) => m.role === "tool"));
  } finally {
    delete process.env.OPENAI_API_KEY;
    updateTenantProfile(sandbox.tenant_id, { llmProvider: "claude" });
  }
});

// ── Limits and interruption ──────────────────────────────────────────────────

test("a runaway tool loop is stopped by the step budget", async () => {
  process.env.SANDBOXOS_ASSISTANT_MAX_STEPS = "3";
  try {
    // Every scripted turn asks for another tool, so the loop never ends on its own.
    const { events, out } = await turnWith(
      [{ tools: [{ name: "fs__list", args: { path: "." } }] }],
      { input: "loop forever" },
    );
    assert.equal(out.stopped, "max_steps");
    assert.equal(events.filter((e) => e.type === "step").length, 3);
  } finally {
    delete process.env.SANDBOXOS_ASSISTANT_MAX_STEPS;
  }
});

test("aborting the signal stops the turn", async () => {
  const controller = new AbortController();
  controller.abort();
  const { out, events } = await turnWith([{ text: "should never be reached" }],
    { input: "hello", signal: controller.signal });
  assert.equal(out.stopped, "cancelled");
  assert.ok(events.some((e) => e.type === "stopped" && e.reason === "cancelled"));
});

test("with no provider key the assistant says so instead of failing obscurely", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const events = [];
    const out = await runTurn({
      kernel, sandbox, principalId: owner.id, heldPatterns: held,
      input: "hi", emit: (e) => events.push(e),
    });
    assert.equal(out.stopped, "no_credential");
    assert.match(events[0].error, /API key/);
  } finally { process.env.ANTHROPIC_API_KEY = saved; }
});

// ── Conversations ────────────────────────────────────────────────────────────

test("a conversation stores its turns and replays them", () => {
  const c = createConversation(sandbox.id, owner.id, "test chat");
  appendConversationMessages(c.id, [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ]);
  const messages = conversationMessages(c.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content[0].text, "hi");

  const listed = listConversations(sandbox.id, owner.id);
  const mine = listed.find((x) => x.id === c.id);
  assert.equal(mine.messages, 2);
  assert.equal(mine.title, "test chat");

  renameConversation(c.id, "renamed");
  assert.equal(listConversations(sandbox.id, owner.id).find((x) => x.id === c.id).title, "renamed");
  assert.deepEqual(deleteConversation(c.id), { deleted: true });
  assert.equal(conversationMessages(c.id).length, 0);
});

test("renderTranscript flattens both provider shapes into renderable items", () => {
  const items = renderTranscript([
    { role: "user", content: [{ type: "text", text: "do it" }] },
    { role: "assistant", content: [
      { type: "text", text: "working" },
      { type: "tool_use", id: "t1", name: "fs__write", input: { path: "x" } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: '{"ok":true}' }] },
    { role: "assistant", content: null, tool_calls: [{ id: "t2", function: { name: "fs__read", arguments: '{"path":"x"}' } }] },
    { role: "tool", tool_call_id: "t2", content: "contents" },
  ]);
  assert.deepEqual(items.map((i) => i.kind),
    ["text", "text", "tool_call", "tool_result", "tool_call", "tool_result"]);
  assert.equal(items[2].name, "fs.write");
  assert.equal(items[4].args.path, "x");
});

test("decodeName survives a tool whose name contains an underscore", () => {
  assert.deepEqual(decodeName("mcp-registry__list"), ["mcp-registry", "list"]);
  assert.deepEqual(decodeName("fs__read"), ["fs", "read"]);
});

// ── Over the Gateway ─────────────────────────────────────────────────────────

const authed = (path, init = {}) =>
  fetch(`${base}/${sandbox.slug}/${path}`, {
    ...init,
    headers: { Cookie: cookie, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

test("the Gateway creates, lists, streams and deletes a conversation", async () => {
  const created = await (await authed("chats", { method: "POST", body: "{}" })).json();
  assert.ok(created.chat.id);

  const stub = stubProvider([
    { tools: [{ name: "fs__write", args: { path: "p22/gateway.txt", content: "via http" } }] },
    { text: "Wrote it through the Gateway." },
  ]);
  process.env.SANDBOXOS_ANTHROPIC_URL = await stub.listen();

  let body = "";
  try {
    const res = await authed(`chats/${created.chat.id}/send`, {
      method: "POST", body: JSON.stringify({ input: "write a file please" }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    body = await res.text();
  } finally { stub.close(); }

  assert.match(body, /"type":"tool_call"/);
  assert.match(body, /"type":"tool_result"/);
  assert.match(body, /"type":"end"/);

  // The transcript survives the request.
  const after = await (await authed(`chats/${created.chat.id}`)).json();
  const kinds = after.transcript.map((i) => i.kind);
  assert.ok(kinds.includes("tool_call"));
  assert.ok(kinds.includes("tool_result"));
  // The first message names the conversation.
  assert.equal(after.chat.title, "write a file please");

  const listed = await (await authed("chats")).json();
  assert.ok(listed.chats.some((c) => c.id === created.chat.id));

  const gone = await (await authed(`chats/${created.chat.id}`, { method: "DELETE" })).json();
  assert.equal(gone.deleted, true);
});

test("a conversation belongs to its principal, not just its Sandbox", async () => {
  // Someone else's conversation in the same Sandbox is invisible to this caller.
  const stranger = createPrincipal(sandbox.tenant_id, "user", "stranger");
  const theirs = createConversation(sandbox.id, stranger.id, "not yours");
  const res = await authed(`chats/${theirs.id}`);
  assert.equal(res.status, 404);
  assert.ok(!(await (await authed("chats")).json()).chats.some((c) => c.id === theirs.id));
});

test("sending with no input is a 400, not an empty turn", async () => {
  const created = await (await authed("chats", { method: "POST", body: "{}" })).json();
  const res = await authed(`chats/${created.chat.id}/send`, { method: "POST", body: JSON.stringify({ input: "  " }) });
  assert.equal(res.status, 400);
});

test("conversations require authentication", async () => {
  const res = await fetch(`${base}/${sandbox.slug}/chats`);
  assert.equal(res.status, 401);
});
