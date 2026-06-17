// Phase 9: Sandbox Fleet — list, wake, hibernate, delete.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import {
  ensureSeed, createSandboxForTenant, mintMachineToken,
  listSandboxesForTenant, deleteSandbox, sandboxCountForTenant,
} from "../packages/control-db/src/registry.js";
import { _dropKernel } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";

let owner, sandbox, token, srv, port;

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  const m = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "p9-test" });
  token = m.token;
  srv = createServer();
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  port = srv.address().port;
});
test.after(() => { srv.close(); closeDb(); });

async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// ─── Registry helpers ────────────────────────────────────────────────────────

test("listSandboxesForTenant returns seed sandbox", () => {
  const all = listSandboxesForTenant(owner.tenant_id);
  assert.ok(Array.isArray(all));
  assert.ok(all.some((sb) => sb.id === sandbox.id));
});

test("deleteSandbox removes all related rows", () => {
  const sb2 = createSandboxForTenant(owner.tenant_id, owner.id, {
    slug: "fleet-del-unit", name: "del-unit", cellBackend: "local",
  });
  deleteSandbox(sb2.id);
  _dropKernel(sb2.id);
  const all = listSandboxesForTenant(owner.tenant_id);
  assert.ok(!all.some((s) => s.id === sb2.id));
});

// ─── GET /api/sandboxes ──────────────────────────────────────────────────────

test("GET /api/sandboxes 401 without auth", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/sandboxes`);
  const d = await r.json();
  assert.strictEqual(d.ok, false);
});

test("GET /api/sandboxes returns list with state", async () => {
  const d = await api("/api/sandboxes");
  assert.strictEqual(d.ok, true);
  assert.ok(Array.isArray(d.sandboxes));
  assert.ok(d.sandboxes.some((sb) => sb.slug === sandbox.slug));
  const sb = d.sandboxes.find((s) => s.slug === sandbox.slug);
  assert.ok("state" in sb, "missing state");
  assert.ok("id" in sb, "missing id");
  assert.ok("name" in sb, "missing name");
  assert.ok("cell_backend" in sb, "missing cell_backend");
});

test("GET /api/sandboxes returns created_at and last_active_at fields", async () => {
  const d = await api("/api/sandboxes");
  const sb = d.sandboxes.find((s) => s.slug === sandbox.slug);
  assert.ok("created_at" in sb, "missing created_at");
  assert.ok("last_active_at" in sb, "missing last_active_at");
});

// ─── DELETE /api/sandboxes/:slug ─────────────────────────────────────────────

test("DELETE /api/sandboxes/:slug 401 without auth", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/sandboxes/${sandbox.slug}`, { method: "DELETE" });
  const d = await r.json();
  assert.strictEqual(d.ok, false);
});

test("DELETE /api/sandboxes/:slug 404 on unknown sandbox", async () => {
  const d = await api("/api/sandboxes/no-such-fleet-slug", { method: "DELETE" });
  assert.strictEqual(d.ok, false);
});

test("DELETE /api/sandboxes/:slug 409 when last sandbox", async () => {
  // Only run this assertion when the tenant truly has one sandbox.
  const count = sandboxCountForTenant(owner.tenant_id);
  if (count !== 1) return; // skip — test order or parallel creation may have added extras
  const d = await api(`/api/sandboxes/${sandbox.slug}`, { method: "DELETE" });
  assert.strictEqual(d.ok, false);
  assert.ok(d.error.includes("last sandbox"), `unexpected error: ${d.error}`);
});

test("DELETE /api/sandboxes/:slug removes the sandbox", async () => {
  const sb2 = createSandboxForTenant(owner.tenant_id, owner.id, {
    slug: "fleet-del-api", name: "del-api", cellBackend: "local",
  });
  const d = await api(`/api/sandboxes/${sb2.slug}`, { method: "DELETE" });
  assert.strictEqual(d.ok, true, `expected ok, got error: ${d.error}`);
  assert.strictEqual(d.deleted, sb2.slug);
  const all = listSandboxesForTenant(owner.tenant_id);
  assert.ok(!all.some((s) => s.id === sb2.id), "sandbox still present after delete");
});

// ─── POST /:slug/wake ────────────────────────────────────────────────────────

test("POST /:slug/wake 401 without auth", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/wake`, { method: "POST" });
  const d = await r.json();
  assert.strictEqual(d.ok, false);
});

test("POST /:slug/wake returns running state", async () => {
  const d = await api(`/${sandbox.slug}/wake`, { method: "POST" });
  assert.strictEqual(d.ok, true, `wake failed: ${d.error}`);
  assert.strictEqual(d.state, "running");
});

test("POST /:slug/wake is idempotent", async () => {
  const d1 = await api(`/${sandbox.slug}/wake`, { method: "POST" });
  const d2 = await api(`/${sandbox.slug}/wake`, { method: "POST" });
  assert.strictEqual(d1.state, "running");
  assert.strictEqual(d2.state, "running");
});

// ─── POST /:slug/hibernate ───────────────────────────────────────────────────

test("POST /:slug/hibernate 401 without auth", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/hibernate`, { method: "POST" });
  const d = await r.json();
  assert.strictEqual(d.ok, false);
});

test("POST /:slug/hibernate returns stopped state", async () => {
  await api(`/${sandbox.slug}/wake`, { method: "POST" });
  const d = await api(`/${sandbox.slug}/hibernate`, { method: "POST" });
  assert.strictEqual(d.ok, true, `hibernate failed: ${d.error}`);
  assert.strictEqual(d.state, "stopped");
});

test("POST /:slug/hibernate is idempotent (already stopped)", async () => {
  const d = await api(`/${sandbox.slug}/hibernate`, { method: "POST" });
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.state, "stopped");
});
