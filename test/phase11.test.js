// Phase 11: Secrets REST API — GET/POST/DELETE /:slug/secrets
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, mintMachineToken } from "../packages/control-db/src/registry.js";
import { createServer } from "../apps/gateway/src/server.js";

let owner, sandbox, token, srv, port;

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  const m = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "p11-test" });
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

// ─── Auth ─────────────────────────────────────────────────────────────────

test("GET /:slug/secrets requires auth", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/secrets`);
  const d = await r.json();
  assert.strictEqual(d.ok, false);
  assert.strictEqual(r.status, 401);
});

test("POST /:slug/secrets requires auth", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/secrets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x", value: "y" }),
  });
  const d = await r.json();
  assert.strictEqual(d.ok, false);
  assert.strictEqual(r.status, 401);
});

test("DELETE /:slug/secrets/:name requires auth", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/secrets/x`, { method: "DELETE" });
  const d = await r.json();
  assert.strictEqual(d.ok, false);
  assert.strictEqual(r.status, 401);
});

// ─── CRUD ─────────────────────────────────────────────────────────────────

test("GET /:slug/secrets returns empty list initially", async () => {
  const d = await api(`/${sandbox.slug}/secrets`);
  assert.strictEqual(d.ok, true);
  assert.ok(Array.isArray(d.secrets), "secrets should be an array");
  assert.strictEqual(d.secrets.length, 0);
});

test("POST /:slug/secrets stores a secret and returns a ref", async () => {
  const d = await api(`/${sandbox.slug}/secrets`, {
    method: "POST", body: { name: "DB_PASSWORD", value: "s3cr3t!" },
  });
  assert.strictEqual(d.ok, true, `store failed: ${d.error}`);
  assert.ok(typeof d.ref === "string" && d.ref.startsWith("secret://"), `unexpected ref: ${d.ref}`);
  assert.ok(!JSON.stringify(d).includes("s3cr3t!"), "value must not appear in response");
});

test("GET /:slug/secrets reflects the stored secret", async () => {
  const d = await api(`/${sandbox.slug}/secrets`);
  assert.strictEqual(d.ok, true);
  assert.ok(d.secrets.some((s) => s.name === "DB_PASSWORD"), "stored secret not found");
  const s = d.secrets.find((s) => s.name === "DB_PASSWORD");
  assert.strictEqual(s.ref, "secret://DB_PASSWORD");
  assert.ok(!Object.values(s).includes("s3cr3t!"), "value must not appear in list");
});

test("GET /:slug/secrets returns created_at field", async () => {
  const d = await api(`/${sandbox.slug}/secrets`);
  const s = d.secrets.find((s) => s.name === "DB_PASSWORD");
  assert.ok(s?.created_at > 0, "expected created_at timestamp");
});

test("POST /:slug/secrets 400 when name missing", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/secrets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ value: "oops" }),
  });
  const d = await r.json();
  assert.strictEqual(d.ok, false);
  assert.strictEqual(r.status, 400);
});

test("POST /:slug/secrets 400 when value missing", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/secrets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "EMPTY" }),
  });
  const d = await r.json();
  assert.strictEqual(d.ok, false);
  assert.strictEqual(r.status, 400);
});

test("POST /:slug/secrets overwrites an existing secret (upsert)", async () => {
  const d1 = await api(`/${sandbox.slug}/secrets`, { method: "POST", body: { name: "DB_PASSWORD", value: "newpass" } });
  assert.strictEqual(d1.ok, true);
  // Value is still never visible — just verify the upsert succeeded and the list still has one entry with that name.
  const d2 = await api(`/${sandbox.slug}/secrets`);
  const matches = d2.secrets.filter((s) => s.name === "DB_PASSWORD");
  assert.strictEqual(matches.length, 1, "upsert should keep exactly one entry");
});

test("DELETE /:slug/secrets/:name removes the secret", async () => {
  // Store another secret to delete.
  await api(`/${sandbox.slug}/secrets`, { method: "POST", body: { name: "TMP_KEY", value: "tmp" } });
  const d = await api(`/${sandbox.slug}/secrets/TMP_KEY`, { method: "DELETE" });
  assert.strictEqual(d.ok, true, `delete failed: ${d.error}`);
  assert.strictEqual(d.removed, true);
  const list = await api(`/${sandbox.slug}/secrets`);
  assert.ok(!list.secrets.some((s) => s.name === "TMP_KEY"), "secret still present after delete");
});

test("DELETE /:slug/secrets/:name for non-existent secret returns removed:false", async () => {
  const d = await api(`/${sandbox.slug}/secrets/NO_SUCH_SECRET`, { method: "DELETE" });
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.removed, false);
});

test("multiple secrets can be stored and listed", async () => {
  await api(`/${sandbox.slug}/secrets`, { method: "POST", body: { name: "API_KEY", value: "key1" } });
  await api(`/${sandbox.slug}/secrets`, { method: "POST", body: { name: "WEBHOOK_SECRET", value: "wh1" } });
  const d = await api(`/${sandbox.slug}/secrets`);
  assert.ok(d.secrets.some((s) => s.name === "API_KEY"), "API_KEY not found");
  assert.ok(d.secrets.some((s) => s.name === "WEBHOOK_SECRET"), "WEBHOOK_SECRET not found");
  const raw = JSON.stringify(d);
  assert.ok(!raw.includes("key1") && !raw.includes("wh1"), "secret values leaked into response");
});

test("secrets are accessible via kernel.call secrets.list", async () => {
  const d = await api(`/${sandbox.slug}/mcp`, {
    method: "POST", body: { server: "secrets", tool: "list", args: {} },
  });
  assert.strictEqual(d.ok, true);
  assert.ok(Array.isArray(d.result.secrets));
  assert.ok(d.result.secrets.some((s) => s.name === "DB_PASSWORD"), "DB_PASSWORD should appear in kernel.call result");
});
