// Control-plane Scheduler: wake / budget / LRU eviction / idle reaping.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, createSandboxForTenant, getSandboxBySlug } from "../packages/control-db/src/registry.js";
import { Scheduler } from "../packages/scheduler/src/scheduler.js";

let A, B, C;

test.before(() => {
  openDb();
  const { tenant, owner, sandbox } = ensureSeed("local");
  A = sandbox;
  B = createSandboxForTenant(tenant.id, owner.id, { slug: "boxb", name: "B", cellBackend: "local" });
  C = createSandboxForTenant(tenant.id, owner.id, { slug: "boxc", name: "C", cellBackend: "local" });
});
test.after(() => closeDb());

test("wakes within budget; evicts the LRU Cell past budget", async () => {
  const s = new Scheduler({ maxRunning: 2, idleMs: 1_000 });
  await s.wake(A, {}, 1);
  await s.wake(B, {}, 2);
  assert.equal(s.runningCount(), 2);
  const r = await s.wake(C, {}, 3);   // over budget → evict LRU (A)
  assert.equal(r.evicted, A.id);
  assert.equal(s.isRunning(A.id), false);
  assert.ok(s.isRunning(B.id) && s.isRunning(C.id));
});

test("touch updates recency so the active Cell isn't the eviction victim", async () => {
  const s = new Scheduler({ maxRunning: 2, idleMs: 1_000 });
  await s.wake(A, {}, 1);
  await s.wake(B, {}, 2);
  s.touch(A.id, 10);                  // A is now more recent than B
  const r = await s.wake(C, {}, 11);
  assert.equal(r.evicted, B.id);      // B is the LRU now
});

test("reapIdle hibernates Cells idle beyond idleMs", async () => {
  const s = new Scheduler({ maxRunning: 5, idleMs: 100 });
  await s.wake(A, {}, 1000);
  await s.wake(B, {}, 1000);
  const reaped = await s.reapIdle(2000); // 1000ms idle > 100ms
  assert.equal(reaped.length, 2);
  assert.equal(s.runningCount(), 0);
});
