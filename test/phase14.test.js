// Phase 14: Product Gate — per-tenant quota, distro snapshot, distro delete,
// Cloudflare Tunnel health flag.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import {
  ensureSeed, createTenant, mintMachineToken,
  getQuota, setQuota, createDistro, deleteDistro, listDistros,
  sandboxCountForTenant, createSandboxForTenant,
} from "../packages/control-db/src/registry.js";
import { getKernel } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";

let owner, sandbox, tenant, kernel, held, token, srv, port;

test.before(async () => {
  openDb();
  ({ owner, sandbox, tenant } = ensureSeed("local"));
  kernel = await getKernel(sandbox);
  held = ["*"];
  const m = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "p14-test" });
  token = m.token;
  srv = createServer();
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  port = srv.address().port;
});
test.after(() => { srv.close(); closeDb(); });

async function api(method, urlPath, body) {
  const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// ─── getQuota / setQuota unit tests ─────────────────────────────────────────

test("getQuota returns defaults when no quota row exists", () => {
  const newTenant = createTenant("quota-test-tenant-p14");
  const q = getQuota(newTenant.id);
  assert.strictEqual(q.max_sandboxes, 3);
  assert.strictEqual(q.max_agents, 10);
  assert.strictEqual(q.max_running, 2);
});

test("setQuota writes a row and getQuota reads it back", () => {
  const newTenant = createTenant("quota-set-tenant-p14");
  const set = setQuota(newTenant.id, { maxSandboxes: 7, maxAgents: 20, maxRunning: 5 });
  assert.strictEqual(set.max_sandboxes, 7);
  assert.strictEqual(set.max_agents, 20);
  assert.strictEqual(set.max_running, 5);
  const read = getQuota(newTenant.id);
  assert.strictEqual(read.max_sandboxes, 7);
  assert.strictEqual(read.max_agents, 20);
  assert.strictEqual(read.max_running, 5);
});

test("setQuota upserts — second call overwrites first", () => {
  const t = createTenant("quota-upsert-p14");
  setQuota(t.id, { maxSandboxes: 2 });
  setQuota(t.id, { maxSandboxes: 5, maxAgents: 3 });
  const q = getQuota(t.id);
  assert.strictEqual(q.max_sandboxes, 5);
  assert.strictEqual(q.max_agents, 3);
});

test("setQuota with partial args preserves other values", () => {
  const t = createTenant("quota-partial-p14");
  setQuota(t.id, { maxSandboxes: 8, maxAgents: 15, maxRunning: 4 });
  setQuota(t.id, { maxSandboxes: 9 }); // only change maxSandboxes
  const q = getQuota(t.id);
  assert.strictEqual(q.max_sandboxes, 9);
  assert.strictEqual(q.max_agents, 15);  // preserved
  assert.strictEqual(q.max_running, 4);  // preserved
});

// ─── GET/POST /api/quota REST tests ─────────────────────────────────────────

test("GET /api/quota requires auth", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/quota`);
  const d = await r.json();
  assert.strictEqual(r.status, 401);
  assert.ok(!d.ok);
});

test("GET /api/quota returns tenant quota with defaults", async () => {
  const d = await api("GET", "/api/quota");
  assert.ok(d.ok, JSON.stringify(d));
  assert.ok(typeof d.quota.max_sandboxes === "number");
  assert.ok(typeof d.quota.max_agents === "number");
  assert.ok(typeof d.quota.max_running === "number");
});

test("POST /api/quota updates quota", async () => {
  const d = await api("POST", "/api/quota", { maxSandboxes: 6, maxAgents: 12 });
  assert.ok(d.ok, JSON.stringify(d));
  assert.strictEqual(d.quota.max_sandboxes, 6);
  assert.strictEqual(d.quota.max_agents, 12);
  // read back
  const read = await api("GET", "/api/quota");
  assert.strictEqual(read.quota.max_sandboxes, 6);
});

// ─── Sandbox creation quota enforcement ─────────────────────────────────────

test("POST /api/sandboxes respects per-tenant max_sandboxes quota", async () => {
  // Set quota to current count (so the next create is rejected).
  const count = sandboxCountForTenant(tenant.id);
  setQuota(tenant.id, { maxSandboxes: count });
  const d = await api("POST", "/api/sandboxes", { slug: "quota-blocked-p14" });
  assert.ok(!d.ok, "expected sandbox create to be rejected");
  assert.ok(d.error.includes("quota exceeded") || d.error.includes("max"));
  // Restore sensible quota.
  setQuota(tenant.id, { maxSandboxes: 10 });
});

// ─── Agent spawn quota enforcement ───────────────────────────────────────────

test("POST /:slug/mcp agents.spawn respects max_agents quota", async () => {
  // Set max_agents to 0 for this tenant.
  setQuota(tenant.id, { maxAgents: 0 });
  const d = await api("POST", `/${sandbox.slug}/mcp`, { server: "agents", tool: "spawn",
    args: { name: "blocked-agent", patterns: ["proc.exec"], cmd: "echo hi" } });
  assert.ok(!d.ok, "expected spawn to be blocked");
  assert.ok(d.error.includes("quota exceeded") || d.error.includes("max"));
  // Restore.
  setQuota(tenant.id, { maxAgents: 10 });
});

// ─── Distro delete ────────────────────────────────────────────────────────────

test("deleteDistro removes the distro row", () => {
  createDistro(tenant.id, { name: "delete-me-p14", description: "temp", manifest: {} });
  const before = listDistros(tenant.id).find((d) => d.name === "delete-me-p14");
  assert.ok(before, "expected distro to exist before delete");
  const result = deleteDistro(tenant.id, "delete-me-p14");
  assert.ok(result.deleted);
  const after = listDistros(tenant.id).find((d) => d.name === "delete-me-p14");
  assert.ok(!after, "expected distro to be gone after delete");
});

test("deleteDistro returns deleted=false for unknown name", () => {
  const result = deleteDistro(tenant.id, "no-such-distro-p14");
  assert.strictEqual(result.deleted, false);
});

test("DELETE /api/distros/:name removes via REST", async () => {
  await api("POST", "/api/distros", { name: "rest-delete-p14" });
  const d = await api("DELETE", "/api/distros/rest-delete-p14");
  assert.ok(d.ok);
  assert.ok(d.deleted);
  const list = await api("GET", "/api/distros");
  assert.ok(!list.distros.find((x) => x.name === "rest-delete-p14"));
});

// ─── Snapshot → distro → create sandbox from distro ─────────────────────────

test("POST /api/sandboxes/:slug/snapshot creates a distro from sandbox manifest", async () => {
  const d = await api("POST", `/api/sandboxes/${sandbox.slug}/snapshot`, { name: "snap-p14" });
  assert.ok(d.ok, JSON.stringify(d));
  assert.strictEqual(d.name, "snap-p14");
  assert.ok(typeof d.id === "string");
});

test("snapshot distro appears in distros list", async () => {
  await api("POST", `/api/sandboxes/${sandbox.slug}/snapshot`, { name: "snap-list-p14" });
  const list = await api("GET", "/api/distros");
  assert.ok(list.distros.find((d) => d.name === "snap-list-p14"), "snapshot distro missing from list");
});

test("POST /api/sandboxes snapshot requires name", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/sandboxes/${sandbox.slug}/snapshot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const d = await r.json();
  assert.strictEqual(r.status, 400);
  assert.ok(!d.ok);
});

test("POST /api/sandboxes creates sandbox from snapshot distro", async () => {
  await api("POST", `/api/sandboxes/${sandbox.slug}/snapshot`, { name: "snap-from-p14" });
  const d = await api("POST", "/api/sandboxes", { slug: "from-snap-p14", distro: "snap-from-p14" });
  assert.ok(d.ok, JSON.stringify(d));
  assert.strictEqual(d.slug, "from-snap-p14");
});

// ─── Health tunnel flag ──────────────────────────────────────────────────────

test("GET /health includes tunnel field (false when env var not set)", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/health`);
  const d = await r.json();
  assert.ok(d.ok);
  assert.strictEqual(typeof d.tunnel, "boolean");
  // In tests SANDBOXOS_TUNNEL_TOKEN is not set.
  assert.strictEqual(d.tunnel, false);
});
