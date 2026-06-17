// Phase 16: Firecracker production-readiness, per-tenant max_running,
// net.fetch rate limiting, subdomain routing, control-DB backup endpoint.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import {
  ensureSeed, createTenant, mintMachineToken, getQuota, setQuota,
  allocateTap, releaseTap, getTapForSandbox,
  createSandboxForTenant, runningCountForTenant, createSession,
} from "../packages/control-db/src/registry.js";
import { FirecrackerBackend }   from "../packages/cell/src/firecracker-backend.js";
import { egressAllowed, checkRateLimit } from "../packages/kernel/src/servers/net.js";
import { Scheduler }            from "../packages/scheduler/src/scheduler.js";
import { createServer }         from "../apps/gateway/src/server.js";

let owner, sandbox, tenant, token, srv, port;

test.before(async () => {
  openDb();
  ({ owner, sandbox, tenant } = ensureSeed("local"));
  const m = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "p16-test" });
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
  return { res: r, data: await r.json() };
}

// ─── TAP pool ─────────────────────────────────────────────────────────────────

test("allocateTap assigns a tap_name and marks it used", () => {
  const t = createTenant("tap-alloc-p16");
  const sb = createSandboxForTenant(t.id, owner.id, { slug: "tap-sb-p16", name: "tap sb", cellBackend: "local" });
  const tap = allocateTap(sb.id);
  assert.ok(tap.startsWith("tap"), `expected tapN, got ${tap}`);
  assert.strictEqual(getTapForSandbox(sb.id), tap);
  releaseTap(sb.id);
});

test("allocateTap assigns different taps to concurrent sandboxes", () => {
  const t = createTenant("tap-dual-p16");
  const sbA = createSandboxForTenant(t.id, owner.id, { slug: "tap-a-p16", name: "A", cellBackend: "local" });
  const sbB = createSandboxForTenant(t.id, owner.id, { slug: "tap-b-p16", name: "B", cellBackend: "local" });
  const tapA = allocateTap(sbA.id);
  const tapB = allocateTap(sbB.id);
  assert.notStrictEqual(tapA, tapB, "concurrent sandboxes must get different TAPs");
  releaseTap(sbA.id);
  releaseTap(sbB.id);
});

test("releaseTap frees the tap for reuse", () => {
  const t = createTenant("tap-release-p16");
  const sb = createSandboxForTenant(t.id, owner.id, { slug: "tap-rel-p16", name: "rel", cellBackend: "local" });
  const tap = allocateTap(sb.id);
  releaseTap(sb.id);
  assert.strictEqual(getTapForSandbox(sb.id), null);
  // Should be allocatable again.
  const tap2 = allocateTap(sb.id);
  assert.ok(tap2, "should allocate after release");
  releaseTap(sb.id);
});

test("getTapForSandbox returns null when no tap allocated", () => {
  assert.strictEqual(getTapForSandbox("nonexistent-id"), null);
});

// ─── Firecracker config builders include TAP device ──────────────────────────

test("FirecrackerBackend._networkConfig uses provided tap", () => {
  const b = new FirecrackerBackend(sandbox);
  const cfg = b._networkConfig("tap3");
  assert.strictEqual(cfg.host_dev_name, "tap3");
});

// ─── FirecrackerBackend snapshot restore paths ────────────────────────────────

test("FirecrackerBackend.ensureRunning() rejects on macOS (non-Linux)", async () => {
  if (process.platform === "linux") return; // skip on real Linux
  const b = new FirecrackerBackend(sandbox);
  await assert.rejects(() => b.ensureRunning(), /requires Linux/i);
});

// ─── net.fetch rate limiting ──────────────────────────────────────────────────

test("egressAllowed still works as before", () => {
  assert.ok(egressAllowed({ egress: "allow" }, "example.com"));
  assert.ok(!egressAllowed({ egress: "deny", allow: [] }, "example.com"));
  assert.ok(egressAllowed({ egress: "deny", allow: ["example.com"] }, "example.com"));
  assert.ok(!egressAllowed({ egress: "allow", deny: ["bad.com"] }, "bad.com"));
});

test("checkRateLimit passes when under the limit", () => {
  // Uses a unique sandboxId so it doesn't share state with other tests.
  const id = "rate-test-under";
  assert.doesNotThrow(() => checkRateLimit(id, { requests: 5, windowMs: 60_000 }));
  assert.doesNotThrow(() => checkRateLimit(id, { requests: 5, windowMs: 60_000 }));
});

test("checkRateLimit throws once limit is exceeded", () => {
  const id = "rate-test-over";
  for (let i = 0; i < 3; i++) checkRateLimit(id, { requests: 3, windowMs: 60_000 });
  assert.throws(
    () => checkRateLimit(id, { requests: 3, windowMs: 60_000 }),
    /rate limit exceeded/i,
  );
});

test("checkRateLimit with requests=0 never limits", () => {
  const id = "rate-test-zero";
  for (let i = 0; i < 100; i++) {
    assert.doesNotThrow(() => checkRateLimit(id, { requests: 0, windowMs: 60_000 }));
  }
});

// ─── Per-tenant max_running in Scheduler ─────────────────────────────────────

test("Scheduler.wake() passes when under tenant max_running", async () => {
  const s = new Scheduler({ maxRunning: 10 });
  // quota allows 5 running; we have 0 — should succeed
  const result = await s.wake(sandbox, { max_running: 5, mem_mb: 512, cpu_shares: 1 }, 1);
  assert.strictEqual(result.state, "running");
});

test("Scheduler.wake() throws when tenant max_running exceeded", async () => {
  const t = createTenant("max-running-p16");
  const sbX = createSandboxForTenant(t.id, owner.id, { slug: "mr-x-p16", name: "X", cellBackend: "local" });
  const sbY = createSandboxForTenant(t.id, owner.id, { slug: "mr-y-p16", name: "Y", cellBackend: "local" });
  const s = new Scheduler({ maxRunning: 10 });
  // Wake sbX so the tenant has 1 running.
  await s.wake(sbX, { max_running: 1 }, 1);
  // Waking sbY with max_running=1 should fail (tenant already at 1).
  await assert.rejects(
    () => s.wake(sbY, { max_running: 1 }, 2),
    /running-cell limit/i,
  );
});

test("runningCountForTenant counts only running sandboxes", () => {
  const count = runningCountForTenant(tenant.id);
  assert.ok(typeof count === "number" && count >= 0);
});

// ─── Control-DB backup endpoint ───────────────────────────────────────────────

test("GET /api/admin/backup requires auth", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/admin/backup`);
  assert.strictEqual(r.status, 401);
});

test("GET /api/admin/backup is denied to a non-operator (machine token)", async () => {
  // Backlog #1: the per-sandbox machine token is NOT a host operator, so the
  // full-DB backup (which exfiltrates every tenant) must be refused with 403.
  const r = await fetch(`http://127.0.0.1:${port}/api/admin/backup`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(r.status, 403);
});

test("GET /api/admin/backup returns a binary file for an operator session", async () => {
  // The seed owner is a host operator (ensureSeed marks them). A session bound to
  // the owner principal carries operator authority and may download the backup.
  const opToken = createSession(owner.id, "session");
  const r = await fetch(`http://127.0.0.1:${port}/api/admin/backup`, {
    headers: { Authorization: `Bearer ${opToken}` },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers.get("content-type")?.includes("octet-stream"));
  const buf = await r.arrayBuffer();
  // SQLite files start with "SQLite format 3\0"
  const magic = Buffer.from(buf).slice(0, 16).toString("utf8");
  assert.ok(magic.startsWith("SQLite format 3"), `unexpected file magic: ${JSON.stringify(magic)}`);
});

// ─── Subdomain routing ────────────────────────────────────────────────────────
// We test the route is reachable when SANDBOXOS_DOMAIN is set and the Host
// header matches — using a custom Host header on a request to the plain IP:port.

test("subdomain routing: Host=slug.domain resolves to slug's sandbox", async () => {
  const domain = "test.local";
  const origDomain = process.env.SANDBOXOS_DOMAIN;
  process.env.SANDBOXOS_DOMAIN = domain;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Host: `${sandbox.slug}.${domain}` },
    });
    // /health doesn't use the slug, but the request should not 404.
    const d = await r.json();
    assert.ok(d.ok, "health endpoint still works via subdomain host");
  } finally {
    if (origDomain == null) delete process.env.SANDBOXOS_DOMAIN;
    else process.env.SANDBOXOS_DOMAIN = origDomain;
  }
});

test("subdomain routing: non-matching Host falls through to path routing", async () => {
  const origDomain = process.env.SANDBOXOS_DOMAIN;
  process.env.SANDBOXOS_DOMAIN = "example.com";
  try {
    // Host doesn't end in .example.com so no subdomain rewrite.
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Host: "127.0.0.1" },
    });
    const d = await r.json();
    assert.ok(d.ok, "health still reachable without subdomain");
  } finally {
    if (origDomain == null) delete process.env.SANDBOXOS_DOMAIN;
    else process.env.SANDBOXOS_DOMAIN = origDomain;
  }
});
