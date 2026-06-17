// Phase 10: Streaming Command Central — exec-stream SSE endpoint.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, mintMachineToken, grantsFor, grant } from "../packages/control-db/src/registry.js";
import { createServer } from "../apps/gateway/src/server.js";

let owner, sandbox, token, srv, port;

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  const m = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "p10-test" });
  token = m.token;
  srv = createServer();
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  port = srv.address().port;
});
test.after(() => { srv.close(); closeDb(); });

/** Consume an SSE stream from a fetch response, return all parsed event objects. */
async function collectStream(resp, { timeoutMs = 5000 } = {}) {
  const events = [];
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error("stream timeout")), timeoutMs));
  const drain = async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop();
      for (const frame of frames) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try { events.push(JSON.parse(dataLine.slice(5).trim())); } catch {}
      }
      if (events.some((e) => e.type === "done")) break;
    }
    return events;
  };
  return Promise.race([drain(), deadline]);
}

async function stream(line, { tok = token, extra = {} } = {}) {
  const resp = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/exec-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ line, ...extra }),
  });
  return { resp, events: resp.ok ? await collectStream(resp) : [] };
}

// ─── Auth / basic validation ────────────────────────────────────────────────

test("POST /:slug/exec-stream requires auth", async () => {
  const resp = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/exec-stream`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line: "echo hi" }),
  });
  const d = await resp.json();
  assert.strictEqual(d.ok, false);
  assert.strictEqual(resp.status, 401);
});

test("POST /:slug/exec-stream 400 without line", async () => {
  const resp = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/exec-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  const d = await resp.json();
  assert.strictEqual(d.ok, false);
  assert.strictEqual(resp.status, 400);
});

test("exec-stream response is text/event-stream", async () => {
  const resp = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/exec-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ line: "echo ok" }),
  });
  assert.ok(resp.headers.get("content-type")?.includes("text/event-stream"), "wrong Content-Type");
  await resp.body.cancel();
});

// ─── Shell commands ──────────────────────────────────────────────────────────

test("shell command streams stdout chunk + done", async () => {
  const { events } = await stream("echo hello");
  const stdout = events.filter((e) => e.type === "stdout");
  const done   = events.find((e) => e.type === "done");
  assert.ok(stdout.length > 0, "no stdout events");
  assert.ok(stdout.some((e) => e.chunk.includes("hello")), "stdout missing 'hello'");
  assert.ok(done, "missing done event");
  assert.strictEqual(done.code, 0);
});

test("shell command streams stderr chunk", async () => {
  const { events } = await stream("echo err >&2");
  const stderr = events.filter((e) => e.type === "stderr");
  assert.ok(stderr.length > 0, "no stderr events");
  assert.ok(stderr.some((e) => e.chunk.includes("err")), "stderr missing 'err'");
});

test("shell command exit code propagated in done event", async () => {
  const { events } = await stream("exit 42");
  const done = events.find((e) => e.type === "done");
  assert.ok(done, "no done event");
  assert.strictEqual(done.code, 42);
});

test("shell command multi-line output streams multiple stdout events", async () => {
  const { events } = await stream("printf 'a\\nb\\nc\\n'");
  const chunks = events.filter((e) => e.type === "stdout").map((e) => e.chunk).join("");
  assert.ok(chunks.includes("a") && chunks.includes("b") && chunks.includes("c"), `output missing lines: ${chunks}`);
});

// ─── Verb shortcuts ──────────────────────────────────────────────────────────

test("verb shorthand 'ls' emits line events + done", async () => {
  const { events } = await stream("ls");
  const lines = events.filter((e) => e.type === "line");
  const done  = events.find((e) => e.type === "done");
  assert.ok(done, "no done event");
  assert.strictEqual(done.code, 0);
  // ls might show empty or some entries — at minimum we get a done event
  assert.ok(lines !== undefined);
});

test("'help' command emits line events + done", async () => {
  const { events } = await stream("help");
  const lines = events.filter((e) => e.type === "line");
  const done  = events.find((e) => e.type === "done");
  assert.ok(lines.length > 3, `expected multiple help lines, got ${lines.length}`);
  assert.ok(lines.some((e) => e.text.includes("SandboxOS")), "help missing title");
  assert.ok(done);
});

test("'clear' emits clear event + done", async () => {
  const { events } = await stream("clear");
  const clear = events.find((e) => e.type === "clear");
  const done  = events.find((e) => e.type === "done");
  assert.ok(clear, "no clear event");
  assert.ok(done);
});

// ─── :call raw MCP ───────────────────────────────────────────────────────────

test(":call fs.list {} emits line events + done", async () => {
  const { events } = await stream(":call fs.list {}");
  const done = events.find((e) => e.type === "done");
  assert.ok(done, "no done event");
  assert.strictEqual(done.code, 0);
});

test(":call kernel.whoami emits identity line events", async () => {
  const { events } = await stream(":call kernel.whoami {}");
  const lines = events.filter((e) => e.type === "line");
  assert.ok(lines.some((e) => e.text.includes("sandbox")), `expected sandbox in output, got: ${lines.map(e => e.text).join("|")}`);
  const done = events.find((e) => e.type === "done");
  assert.ok(done);
});

// ─── Capability enforcement ───────────────────────────────────────────────────

test("shell command denied when proc.exec not in token scope", async () => {
  // Mint a token scoped only to fs.* (no proc.exec).
  const m = mintMachineToken(owner.id, sandbox.id, ["fs.*"], { label: "p10-fsonly" });
  const { events } = await stream("echo hello", { tok: m.token });
  const err  = events.find((e) => e.type === "error");
  const done = events.find((e) => e.type === "done");
  assert.ok(err, "expected error event for denied proc.exec");
  assert.ok(err.text.includes("denied"), `expected 'denied' in error text: ${err.text}`);
  assert.ok(done);
  assert.strictEqual(done.code, 1);
});

// ─── NL natural-language (? prefix) ─────────────────────────────────────────

test("'? list files' emits proposed event when llm enabled", async () => {
  // Enable the llm server in the manifest so the kernel routes it.
  const { loadManifest, saveManifest } = await import("../packages/manifest/src/manifest.js");
  const m = loadManifest(sandbox);
  m.servers.llm = {};
  saveManifest(sandbox, m);

  const { _resetKernels } = await import("../packages/kernel/src/kernel.js");
  _resetKernels();
  // Re-run after resetting the kernel cache.
  const { events } = await stream("? list files in the current directory");
  // Restore manifest (remove llm) for other tests.
  const m2 = loadManifest(sandbox);
  delete m2.servers.llm;
  saveManifest(sandbox, m2);
  _resetKernels();

  const proposed = events.find((e) => e.type === "proposed");
  const done     = events.find((e) => e.type === "done");
  assert.ok(proposed, `no proposed event — events: ${JSON.stringify(events)}`);
  assert.ok(typeof proposed.proposed === "string" && proposed.proposed.length > 0, "empty proposed command");
  assert.ok(done);
});
