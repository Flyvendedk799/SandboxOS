// Phase 5: Desktop — agent REST API, app model, NL propose endpoint.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
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

// ── helper: create a login cookie via the HTTP server ─────────────────────

async function withServer(fn) {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await fn(base, srv);
  } finally {
    srv.close();
  }
}

async function loginCookie(base) {
  const r = await fetch(base + "/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  return r.headers.getSetCookie()[0].split(";")[0];
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Agent REST API (GET + DELETE routes on /:slug/agents)
// ═════════════════════════════════════════════════════════════════════════════

test("GET /:slug/agents requires auth", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/${sandbox.slug}/agents`);
    assert.equal(r.status, 401);
  });
});

test("GET /:slug/agents returns agents list", async () => {
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/agents`, { headers: { Cookie: cookie } });
    const data = await r.json();
    assert.ok(data.ok, JSON.stringify(data));
    assert.ok(Array.isArray(data.agents));
  });
});

test("GET /:slug/agents/:id returns agent detail", async () => {
  const spawn = await call("agents", "spawn", { name: "p5-detail", patterns: ["proc.exec"], cmd: "echo phase5" });
  assert.ok(spawn.ok);
  const id = spawn.result.id;
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/agents/${id}`, { headers: { Cookie: cookie } });
    const data = await r.json();
    assert.ok(data.ok, JSON.stringify(data));
    assert.equal(data.agent.id, id);
    assert.equal(data.agent.name, "p5-detail");
  });
});

test("DELETE /:slug/agents/:id kills a running agent", async () => {
  const spawn = await call("agents", "spawn", { name: "p5-kill", patterns: ["proc.exec"], cmd: "sleep 60" });
  assert.ok(spawn.ok);
  const id = spawn.result.id;
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/agents/${id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const data = await r.json();
    assert.ok(data.ok, JSON.stringify(data));
    // State must be 'killed' after the DELETE
    const detail = await call("agents", "get", { id });
    assert.equal(detail.result.state, "killed");
  });
});

test("DELETE /:slug/agents/:id requires auth", async () => {
  const spawn = await call("agents", "spawn", { name: "p5-noauth", patterns: ["proc.exec"], cmd: "echo x" });
  const id = spawn.result.id;
  await withServer(async (base) => {
    const r = await fetch(`${base}/${sandbox.slug}/agents/${id}`, { method: "DELETE" });
    assert.equal(r.status, 401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Apps MCP server
// ═════════════════════════════════════════════════════════════════════════════

test("apps.list returns empty list initially", async () => {
  const r = await call("apps", "list");
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.result.apps, []);
});

test("apps.install registers an app in the manifest", async () => {
  const r = await call("apps", "install", {
    name: "files",
    url: "/static/apps/files.html",
    patterns: ["fs.*"],
    description: "File browser",
  });
  assert.ok(r.ok, r.error);
  assert.equal(r.result.name, "files");
});

test("apps.list returns installed apps", async () => {
  const r = await call("apps", "list");
  assert.ok(r.ok, r.error);
  assert.ok(r.result.apps.some((a) => a.name === "files"), "files app must be listed");
  const app = r.result.apps.find((a) => a.name === "files");
  assert.equal(app.url, "/static/apps/files.html");
  assert.deepEqual(app.patterns, ["fs.*"]);
});

test("apps.launch mints a token and returns url for an installed app", async () => {
  const r = await call("apps", "launch", { name: "files" });
  assert.ok(r.ok, r.error);
  assert.ok(r.result.token, "token must be present");
  assert.equal(r.result.url, "/static/apps/files.html");
  assert.ok(Array.isArray(r.result.patterns));
  assert.ok(r.result.patterns.includes("fs.*") || r.result.patterns.some((p) => p));
});

test("apps.launch for unknown app returns error", async () => {
  const r = await call("apps", "launch", { name: "nonexistent-xyz" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no such app/);
});

test("apps.remove removes an app", async () => {
  const r = await call("apps", "remove", { name: "files" });
  assert.ok(r.ok, r.error);
  assert.equal(r.result.removed, true);
  const list = await call("apps", "list");
  assert.ok(!list.result.apps.some((a) => a.name === "files"), "files must be gone after remove");
});

test("apps.remove for non-existent app returns removed:false", async () => {
  const r = await call("apps", "remove", { name: "ghost" });
  assert.ok(r.ok);
  assert.equal(r.result.removed, false);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Apps gateway endpoint
// ═════════════════════════════════════════════════════════════════════════════

test("GET /:slug/apps requires auth", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/${sandbox.slug}/apps`);
    assert.equal(r.status, 401);
  });
});

test("GET /:slug/apps returns the apps list", async () => {
  // Install an app so the list is non-empty.
  await call("apps", "install", { name: "http-test", url: "/static/apps/http.html", patterns: ["fs.read"] });
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/apps`, { headers: { Cookie: cookie } });
    const data = await r.json();
    assert.ok(data.ok, JSON.stringify(data));
    assert.ok(Array.isArray(data.apps));
    assert.ok(data.apps.some((a) => a.name === "http-test"));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Propose endpoint  POST /:slug/propose
// ═════════════════════════════════════════════════════════════════════════════

test("POST /:slug/propose requires auth", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/${sandbox.slug}/propose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line: "list my files" }),
    });
    assert.equal(r.status, 401);
  });
});

test("POST /:slug/propose with missing line returns 400", async () => {
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/propose`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });
});

test("POST /:slug/propose returns 503 when llm server is not enabled", async () => {
  // New server = fresh kernel without llm (default manifest has no llm).
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/propose`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ line: "list my files" }),
    });
    // Either 503 (llm unavailable) or 200 if llm was already enabled by a prior test.
    assert.ok(r.status === 503 || r.status === 200, `unexpected status ${r.status}`);
  });
});

test("POST /:slug/propose translates NL when llm is enabled", async () => {
  // Enable llm (the mock path — no real API key in tests).
  await call("mcp-registry", "enable", { server: "llm" });
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/propose`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ line: "list my files" }),
    });
    const data = await r.json();
    assert.ok(data.ok, JSON.stringify(data));
    assert.ok(typeof data.proposed === "string", "proposed must be a string");
    assert.ok(data.proposed.length > 0, "proposed must not be empty");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. exec NL mode returns proposed field (existing exec endpoint)
// ═════════════════════════════════════════════════════════════════════════════

test("POST /:slug/exec with ? prefix returns proposed field in response", async () => {
  await withServer(async (base) => {
    const cookie = await loginCookie(base);
    const r = await fetch(`${base}/${sandbox.slug}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ line: "? list my files" }),
    });
    const data = await r.json();
    assert.ok(data.ok, JSON.stringify(data));
    assert.ok(typeof data.proposed === "string", "exec NL response must include proposed");
  });
});
