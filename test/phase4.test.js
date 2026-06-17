// Phase 4: AI agents, distros, self-service signup, quotas.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, createTenant, createAccount, verifyAccount,
         getAccountByUsername, createDistro, listDistros, getDistroByName,
         sandboxCountForTenant, createSandboxForTenant } from "../packages/control-db/src/registry.js";
import { getKernel } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";
import { buildToolDefs, encodeName, decodeName } from "../packages/agents/src/ai-runner.js";
import { authorize } from "../packages/kernel/src/capabilities.js";

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

// ═════════════════════════════════════════════════════════════════════════════
// 1. AI agent kind (tool-loop infrastructure)
// ═════════════════════════════════════════════════════════════════════════════

test("buildToolDefs builds Anthropic tool defs from kernel catalog, filtered by patterns", () => {
  // With ["fs.*"] the caller may access any fs tool
  const allTools = kernel.listTools();
  const defs = buildToolDefs(allTools, ["fs.*"]);
  assert.ok(defs.length >= 3, "at least list/read/write");
  for (const d of defs) {
    assert.ok(/^[a-zA-Z0-9_-]+$/.test(d.name), `tool name invalid: ${d.name}`);
    assert.match(d.name, /^fs__/);
    assert.ok(typeof d.description === "string");
    assert.ok(d.input_schema);
  }
  // proc tools must NOT appear with fs.* patterns
  assert.ok(!defs.some((d) => d.name.startsWith("proc__")));
});

test("buildToolDefs with '*' includes all catalog tools", () => {
  const defs = buildToolDefs(kernel.listTools(), ["*"]);
  assert.ok(defs.some((d) => d.name.startsWith("fs__")));
  assert.ok(defs.some((d) => d.name.startsWith("proc__")));
  assert.ok(defs.some((d) => d.name.startsWith("agents__")));
});

test("encodeName / decodeName round-trip", () => {
  assert.equal(encodeName("fs", "read"), "fs__read");
  assert.equal(encodeName("mcp-registry", "enable"), "mcp-registry__enable");
  const [s, t] = decodeName("fs__read");
  assert.equal(s, "fs"); assert.equal(t, "read");
  const [s2, t2] = decodeName("mcp-registry__enable");
  assert.equal(s2, "mcp-registry"); assert.equal(t2, "enable");
});

test("agents.spawn with kind=ai creates a queued ai agent", async () => {
  // llm must be enabled for ai agents
  await call("mcp-registry", "enable", { server: "llm" });
  const r = await call("agents", "spawn", {
    name: "ai-test",
    patterns: ["fs.list"],
    kind: "ai",
    prompt: "List the files in the sandbox root.",
    system: "You are a helpful assistant with sandboxOS tool access.",
  });
  assert.ok(r.ok, r.error);
  assert.equal(r.result.kind, "ai");
  assert.ok(r.result.id);
});

test("ai agent without API key transitions to done with mock message", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const spawn = await call("agents", "spawn", {
      name: "mock-ai",
      patterns: ["fs.list"],
      kind: "ai",
      prompt: "hello",
    });
    const id = spawn.result.id;
    // The runner sets done synchronously when no key is present
    await new Promise((r) => setTimeout(r, 200));
    const get = await call("agents", "get", { id });
    assert.ok(get.ok);
    assert.equal(get.result.state, "done");
    assert.ok(get.result.result.includes("ANTHROPIC_API_KEY"));
  } finally {
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("shell agent still works alongside ai kind", async () => {
  const r = await call("agents", "spawn", { name: "shell-still-works", patterns: ["proc.exec"], cmd: "echo phase4" });
  assert.ok(r.ok);
  assert.equal(r.result.kind, "shell");
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Distros
// ═════════════════════════════════════════════════════════════════════════════

test("createDistro stores a manifest template and listDistros returns it", () => {
  const tenant = createTenant("distro-tenant-" + Date.now());
  const manifest = { name: "minimal", servers: { fs: {}, proc: {}, kernel: {}, "mcp-registry": {} } };
  const distro = createDistro(tenant.id, { name: "minimal", description: "Minimal sandbox", manifest });
  assert.ok(distro.id);
  assert.equal(distro.name, "minimal");
  const list = listDistros(tenant.id);
  assert.ok(list.some((d) => d.name === "minimal"));
});

test("getDistroByName retrieves by tenant+name", () => {
  const tenant = createTenant("distro-tenant2-" + Date.now());
  const manifest = { name: "dev", servers: { fs: {}, proc: {}, net: {}, kernel: {}, "mcp-registry": {} } };
  createDistro(tenant.id, { name: "dev", manifest });
  const d = getDistroByName(tenant.id, "dev");
  assert.ok(d);
  assert.equal(d.name, "dev");
  assert.deepEqual(d.manifest, manifest);
});

test("createDistro with duplicate name in same tenant throws", () => {
  const tenant = createTenant("distro-dup-" + Date.now());
  const m = { name: "x", servers: {} };
  createDistro(tenant.id, { name: "x", manifest: m });
  assert.throws(() => createDistro(tenant.id, { name: "x", manifest: m }));
});

test("GET /api/distros returns distros list", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test" }) });
    const cookie = login.headers.getSetCookie()[0].split(";")[0];
    const r = await fetch(base + "/api/distros", { headers: { Cookie: cookie } });
    const data = await r.json();
    assert.ok(data.ok);
    assert.ok(Array.isArray(data.distros));
  } finally { server.close(); }
});

test("POST /api/distros creates a distro from the current sandbox manifest", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test" }) });
    const cookie = login.headers.getSetCookie()[0].split(";")[0];
    const loginData = await login.json();
    const r = await fetch(base + "/api/distros", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "mybase", description: "baseline", slug: loginData.slug }),
    });
    const data = await r.json();
    assert.ok(data.ok, JSON.stringify(data));
    assert.ok(data.id);
    assert.equal(data.name, "mybase");
  } finally { server.close(); }
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Self-service signup
// ═════════════════════════════════════════════════════════════════════════════

test("createAccount creates a principal + hashed credential", () => {
  const tenant = createTenant("acct-tenant-" + Date.now());
  const acc = createAccount(tenant.id, { username: "alice", password: "hunter2!" });
  assert.ok(acc.id);
  assert.ok(acc.principalId);
  assert.equal(acc.username, "alice");
  assert.ok(!acc.hash.includes("hunter2!"), "password not stored in plaintext");
});

test("verifyAccount accepts correct password and rejects wrong one", () => {
  const tenant = createTenant("verify-tenant-" + Date.now());
  createAccount(tenant.id, { username: "bobtest" + Date.now(), password: "correcthorse!" });
  // Use the username we just created
  const last = openDb().prepare("SELECT username FROM accounts ORDER BY created_at DESC LIMIT 1").get();
  const ok = verifyAccount(last.username, "correcthorse!");
  assert.ok(ok, "correct password accepted");
  assert.ok(ok.id, "principal returned");
  const bad = verifyAccount(last.username, "wrongpassword");
  assert.equal(bad, null, "wrong password rejected");
});

test("duplicate username is rejected", () => {
  const tenant = createTenant("dup-acct-" + Date.now());
  createAccount(tenant.id, { username: "duplicated", password: "password1!" });
  assert.throws(() => createAccount(tenant.id, { username: "duplicated", password: "password2!" }), /username taken/);
});

test("POST /signup creates a new account and logs in", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const username = `testuser${Date.now()}`;
    const r = await fetch(base + "/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "securepass123" }),
    });
    const data = await r.json();
    assert.ok(data.ok, JSON.stringify(data));
    assert.ok(data.slug);
    assert.equal(data.username, username);
    // The cookie should be set
    const cookie = r.headers.getSetCookie()[0];
    assert.ok(cookie?.includes("sbx_session="));
  } finally { server.close(); }
});

test("POST /signup with weak password is rejected", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(base + "/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "short", password: "weak" }), // password < 8 chars
    });
    assert.equal(r.status, 400);
  } finally { server.close(); }
});

test("POST /login with username+password works for signup'd users", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const username = `logintest${Date.now()}`;
    await fetch(base + "/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "validpass99" }),
    });
    const r = await fetch(base + "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "validpass99" }),
    });
    const data = await r.json();
    assert.ok(data.ok, JSON.stringify(data));
    assert.equal(data.username, username);
  } finally { server.close(); }
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Quotas
// ═════════════════════════════════════════════════════════════════════════════

test("sandboxCountForTenant counts accurately", () => {
  const tenant = createTenant("quota-tenant-" + Date.now());
  const acc = createAccount(tenant.id, { username: "quotauser" + Date.now(), password: "validpass99" });
  assert.equal(sandboxCountForTenant(tenant.id), 0);
  createSandboxForTenant(tenant.id, acc.principalId, { slug: "qs-1-" + Date.now(), name: "s1", cellBackend: "local" });
  assert.equal(sandboxCountForTenant(tenant.id), 1);
  createSandboxForTenant(tenant.id, acc.principalId, { slug: "qs-2-" + Date.now(), name: "s2", cellBackend: "local" });
  assert.equal(sandboxCountForTenant(tenant.id), 2);
});

test("POST /api/sandboxes returns 429 when sandbox quota exceeded", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const origMax = process.env.SANDBOXOS_MAX_SANDBOXES;
  process.env.SANDBOXOS_MAX_SANDBOXES = "1"; // quota of 1 — seed sandbox already exists
  try {
    const login = await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test" }) });
    const cookie = login.headers.getSetCookie()[0].split(";")[0];
    // seed already has 1 sandbox; quota=1 so this should be rejected
    const r = await fetch(base + "/api/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ slug: "over-quota-" + Date.now(), name: "extra" }),
    });
    assert.equal(r.status, 429);
    const data = await r.json();
    assert.match(data.error, /quota/);
  } finally {
    server.close();
    if (origMax !== undefined) process.env.SANDBOXOS_MAX_SANDBOXES = origMax;
    else delete process.env.SANDBOXOS_MAX_SANDBOXES;
  }
});

test("agents.spawn rejects when agent quota exceeded", async () => {
  const origMax = process.env.SANDBOXOS_MAX_AGENTS;
  process.env.SANDBOXOS_MAX_AGENTS = "0"; // 0 slots → always over quota
  try {
    const r = await call("agents", "spawn", { name: "over-quota", patterns: ["fs.list"], cmd: "echo x" });
    assert.equal(r.ok, false);
    assert.match(r.error, /quota/);
  } finally {
    if (origMax !== undefined) process.env.SANDBOXOS_MAX_AGENTS = origMax;
    else delete process.env.SANDBOXOS_MAX_AGENTS;
  }
});
