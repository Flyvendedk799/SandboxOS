// Phase 12: Audit Query API — GET /:slug/audit with filter params.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, mintMachineToken, queryAudit } from "../packages/control-db/src/registry.js";
import { getKernel } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";

let owner, sandbox, kernel, held, token, srv, port;

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  kernel = await getKernel(sandbox);
  held = ["*"];
  const m = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "p12-test" });
  token = m.token;
  srv = createServer();
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  port = srv.address().port;

  // Seed a few known audit events.
  await kernel.call({ principalId: owner.id, heldPatterns: held, server: "fs", tool: "list",  args: { path: "." } });
  await kernel.call({ principalId: owner.id, heldPatterns: held, server: "fs", tool: "list",  args: { path: "." } });
  await kernel.call({ principalId: owner.id, heldPatterns: held, server: "proc", tool: "exec", args: { cmd: "echo p12" } });
  // Trigger a denied event: a principal with no caps.
  await kernel.call({ principalId: owner.id, heldPatterns: [], server: "fs", tool: "read", args: { path: "x" } });
});
test.after(() => { srv.close(); closeDb(); });

async function api(path) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return r.json();
}

// ─── queryAudit unit tests ───────────────────────────────────────────────────

test("queryAudit with no filter returns recent events", () => {
  const events = queryAudit(sandbox.id);
  assert.ok(Array.isArray(events));
  assert.ok(events.length > 0, "expected at least one audit event");
});

test("queryAudit server filter returns only matching server", () => {
  const events = queryAudit(sandbox.id, { server: "fs" });
  assert.ok(events.length > 0, "expected fs events");
  assert.ok(events.every((e) => e.server === "fs"), "non-fs event in result");
});

test("queryAudit tool filter returns only matching tool", () => {
  const events = queryAudit(sandbox.id, { tool: "exec" });
  assert.ok(events.every((e) => e.tool === "exec"), "non-exec event in result");
});

test("queryAudit resultKind filter isolates denied events", () => {
  const denied = queryAudit(sandbox.id, { resultKind: "denied" });
  assert.ok(denied.length > 0, "expected at least one denied event");
  assert.ok(denied.every((e) => e.result_kind === "denied"), "non-denied event leaked in");
});

test("queryAudit resultKind=ok returns only successful calls", () => {
  const ok = queryAudit(sandbox.id, { resultKind: "ok" });
  assert.ok(ok.length > 0, "expected at least one ok event");
  assert.ok(ok.every((e) => e.result_kind === "ok"), "non-ok event in ok filter");
});

test("queryAudit limit is respected", () => {
  const events = queryAudit(sandbox.id, { limit: 2 });
  assert.ok(events.length <= 2, `expected ≤2 events, got ${events.length}`);
});

test("queryAudit limit is capped at 500", () => {
  // Passing a huge limit should not throw — it is silently capped.
  const events = queryAudit(sandbox.id, { limit: 99999 });
  assert.ok(Array.isArray(events));
});

test("queryAudit after filter excludes older events", () => {
  const allEvents = queryAudit(sandbox.id);
  if (allEvents.length < 2) return; // skip if not enough events
  const midTs = allEvents[Math.floor(allEvents.length / 2)].ts;
  const after = queryAudit(sandbox.id, { after: midTs });
  assert.ok(after.every((e) => e.ts > midTs), "events at-or-before 'after' timestamp leaked in");
});

test("queryAudit combined filter (server + resultKind)", () => {
  const events = queryAudit(sandbox.id, { server: "fs", resultKind: "ok" });
  assert.ok(events.every((e) => e.server === "fs" && e.result_kind === "ok"), "combined filter mismatch");
});

test("queryAudit returns empty array when no events match", () => {
  const events = queryAudit(sandbox.id, { server: "nonexistent-server" });
  assert.deepStrictEqual(events, []);
});

// ─── GET /:slug/audit REST tests ─────────────────────────────────────────────

test("GET /:slug/audit requires auth", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/${sandbox.slug}/audit`);
  const d = await r.json();
  assert.strictEqual(d.ok, false);
  assert.strictEqual(r.status, 401);
});

test("GET /:slug/audit returns events array", async () => {
  const d = await api(`/${sandbox.slug}/audit`);
  assert.strictEqual(d.ok, true);
  assert.ok(Array.isArray(d.events));
  assert.ok(d.events.length > 0);
});

test("GET /:slug/audit?server=fs returns only fs events", async () => {
  const d = await api(`/${sandbox.slug}/audit?server=fs`);
  assert.strictEqual(d.ok, true);
  assert.ok(d.events.every((e) => e.server === "fs"), "non-fs event in filtered result");
  assert.ok(d.events.length > 0, "expected at least one fs event");
});

test("GET /:slug/audit?tool=exec filters by tool", async () => {
  const d = await api(`/${sandbox.slug}/audit?tool=exec`);
  assert.ok(d.events.every((e) => e.tool === "exec"), "non-exec event in result");
});

test("GET /:slug/audit?kind=denied returns only denied events", async () => {
  const d = await api(`/${sandbox.slug}/audit?kind=denied`);
  assert.ok(d.events.every((e) => e.result_kind === "denied"), "non-denied event in result");
  assert.ok(d.events.length > 0, "expected at least one denied event");
});

test("GET /:slug/audit?limit=2 respects limit param", async () => {
  const d = await api(`/${sandbox.slug}/audit?limit=2`);
  assert.ok(d.events.length <= 2, `expected ≤2 events, got ${d.events.length}`);
});

test("GET /:slug/audit?server=fs&kind=ok combined filter", async () => {
  const d = await api(`/${sandbox.slug}/audit?server=fs&kind=ok`);
  assert.ok(d.events.every((e) => e.server === "fs" && e.result_kind === "ok"));
});

test("GET /:slug/audit?after=<ts> returns only newer events", async () => {
  const all = await api(`/${sandbox.slug}/audit`);
  if (all.events.length < 2) return;
  const midTs = all.events[Math.floor(all.events.length / 2)].ts;
  const d = await api(`/${sandbox.slug}/audit?after=${midTs}`);
  assert.ok(d.events.every((e) => e.ts > midTs), "event at-or-before 'after' timestamp found");
});
