// Phase 6: Live Streams — streaming exec, health, stats, agent event SSE.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, totalSandboxCount, tenantAgentStats } from "../packages/control-db/src/registry.js";
import { getKernel } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";

let owner, sandbox, kernel, held;
const call = (server, tool, args = {}) =>
  kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
});
test.after(() => closeDb());

async function withServer(fn) {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base, srv); } finally { srv.close(); }
}

async function loginCookie(base) {
  const r = await fetch(base + "/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  return r.headers.getSetCookie()[0].split(";")[0];
}

// Read a fetch SSE stream into an array of parsed events (stops after timeout or done event).
async function readSSE(response, { maxEvents = 20, timeoutMs = 3000 } = {}) {
  const events = [];
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && events.length < maxEvents) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), deadline - Date.now())),
      ]);
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop();
      for (const f of frames) {
        const dataLine = f.split("\n").find((l) => l.startsWith("data:"));
        if (dataLine) {
          try { events.push(JSON.parse(dataLine.slice(5).trim())); } catch {}
        }
        if (f.includes("event: hello")) {
          const dataLine2 = f.split("\n").find((l) => l.startsWith("data:"));
          if (dataLine2) {
            try { events.push({ _hello: true, ...JSON.parse(dataLine2.slice(5).trim()) }); } catch {}
          }
        }
      }
      if (events.some((e) => e.type === "done")) break;
    }
  } catch { /* timeout or closed */ }
  reader.cancel().catch(() => {});
  return events;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Health endpoint
// ═════════════════════════════════════════════════════════════════════════════

test("GET /health returns ok without auth", async () => {
  await withServer(async (base) => {
    const r = await fetch(base + "/health");
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.ok(data.ok);
  });
});

test("GET /health includes uptime as a positive number", async () => {
  await withServer(async (base) => {
    const data = await (await fetch(base + "/health")).json();
    assert.ok(typeof data.uptime === "number" && data.uptime >= 0);
  });
});

test("GET /health includes sandbox count", async () => {
  await withServer(async (base) => {
    const data = await (await fetch(base + "/health")).json();
    assert.ok(typeof data.sandboxes === "number" && data.sandboxes >= 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Stats endpoint
// ═════════════════════════════════════════════════════════════════════════════

test("GET /api/stats requires auth", async () => {
  await withServer(async (base) => {
    const r = await fetch(base + "/api/stats");
    assert.equal(r.status, 401);
  });
});

test("GET /api/stats returns tenant stats", async () => {
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(base + "/api/stats", { headers: { Cookie: cookie } });
    const data = await r.json();
    assert.ok(data.ok, JSON.stringify(data));
    assert.ok(typeof data.sandboxes === "number");
    assert.ok(typeof data.agents === "object");
    assert.ok(typeof data.agents.total === "number");
    assert.ok(typeof data.quota === "object");
    assert.ok(typeof data.quota.maxSandboxes === "number");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Streaming exec
// ═════════════════════════════════════════════════════════════════════════════

test("POST /:slug/stream requires auth", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/${sandbox.slug}/stream`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "echo hi" }),
    });
    assert.equal(r.status, 401);
  });
});

test("POST /:slug/stream requires cmd field", async () => {
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/stream`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });
});

test("POST /:slug/stream streams stdout as SSE events", async () => {
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/stream`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ cmd: "echo hello-stream" }),
    });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("content-type")?.startsWith("text/event-stream"));
    const events = await readSSE(r);
    assert.ok(events.some((e) => e.type === "stdout" && e.chunk.includes("hello-stream")), `expected stdout chunk, got: ${JSON.stringify(events)}`);
    assert.ok(events.some((e) => e.type === "done"), "expected done event");
  });
});

test("POST /:slug/stream done event carries exit code", async () => {
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/stream`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ cmd: "exit 42" }),
    });
    const events = await readSSE(r);
    const done = events.find((e) => e.type === "done");
    assert.ok(done, "expected done event");
    assert.equal(done.code, 42);
  });
});

test("POST /:slug/stream streams stderr events", async () => {
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/stream`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ cmd: "echo err-output >&2" }),
    });
    const events = await readSSE(r);
    assert.ok(events.some((e) => e.type === "stderr" && e.chunk.includes("err-output")), `expected stderr chunk, got: ${JSON.stringify(events)}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Agent event SSE stream
// ═════════════════════════════════════════════════════════════════════════════

test("GET /:slug/agents/:id/events requires auth", async () => {
  const spawn = await call("agents", "spawn", { name: "p6-ev-noauth", patterns: ["proc.exec"], cmd: "echo x" });
  const id = spawn.result.id;
  await withServer(async (base) => {
    const r = await fetch(`${base}/${sandbox.slug}/agents/${id}/events`);
    assert.equal(r.status, 401);
  });
});

test("GET /:slug/agents/:id/events sends hello event with agent state", async () => {
  const spawn = await call("agents", "spawn", { name: "p6-ev-hello", patterns: ["proc.exec"], cmd: "echo y" });
  const id = spawn.result.id;
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/agents/${id}/events`, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("content-type")?.startsWith("text/event-stream"));
    const events = await readSSE(r, { maxEvents: 5, timeoutMs: 500 });
    // The hello event appears as { _hello: true, agentId, state }
    assert.ok(events.some((e) => e._hello && e.agentId === id), `hello event not found in: ${JSON.stringify(events)}`);
  });
});

test("GET /:slug/agents/bad-id/events returns 404", async () => {
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/agents/bad-id-xyz/events`, { headers: { Cookie: cookie } });
    assert.equal(r.status, 404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Registry helpers
// ═════════════════════════════════════════════════════════════════════════════

test("totalSandboxCount returns at least 1 (seed sandbox exists)", () => {
  const n = totalSandboxCount();
  assert.ok(n >= 1, `expected >= 1, got ${n}`);
});

test("tenantAgentStats returns accurate counts", async () => {
  const before = tenantAgentStats(sandbox.tenant_id);
  await call("agents", "spawn", { name: "p6-stats", patterns: ["proc.exec"], cmd: "echo stats" });
  // Wait for the agent to finish
  await new Promise((r) => setTimeout(r, 200));
  const after = tenantAgentStats(sandbox.tenant_id);
  assert.ok(after.total > before.total, "total count should increase after spawn");
});
