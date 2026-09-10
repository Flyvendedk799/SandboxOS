// Phase 41: snapshots on a schedule.
//
// The last piece of T3.4 in goal.md. Nothing new in the machine: a scheduled
// snapshot is a `cron` job that calls `desktop.checkpoint` on your behalf, with
// your capabilities, audited like any other call. What is new is that it cannot
// quietly cost you the desktop you named on purpose — the scheduler's snapshots
// hold their own slots.
import { readSource } from "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, queryAudit } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { cronTick } from "../packages/scheduler/src/cron-runner.js";
import { LIMITS } from "../packages/os/src/schema.js";
import { osPath } from "../packages/os/src/store.js";
import path from "node:path";

let kernel, owner, sandbox, held;
const call = (server, tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
const ok = async (server, tool, args) => { const r = await call(server, tool, args); assert.ok(r.ok, `${server}.${tool}: ${r.error}`); return r.result; };
const doc = async () => (await ok("desktop", "state", {})).doc;
const read = (rel) => readSource(new URL(rel, import.meta.url));

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  await ok("desktop", "reset", {});
});
test.after(() => { _resetKernels(); closeDb(); });

// ── the scheduler's snapshots have their own shelf ─────────────────────────

test("a scheduled snapshot is marked as the scheduler's", async () => {
  const mine = await ok("desktop", "checkpoint", { name: "the desktop I like" });
  assert.equal(mine.checkpoint.auto, undefined, "one you named carries no flag");

  const theirs = await ok("desktop", "checkpoint", { name: "Scheduled snapshot", auto: true });
  assert.equal(theirs.checkpoint.auto, true, "one the scheduler made says so");

  const list = (await ok("desktop", "checkpoints", {})).checkpoints;
  assert.equal(list.length, 2);
  assert.equal(list.filter((c) => c.auto).length, 1);
});

test("automatic snapshots cannot push out a desktop you named", async () => {
  await ok("desktop", "reset", {});
  const keep = await ok("desktop", "checkpoint", { name: "keep me" });
  // Twice the automatic budget, and then some: enough that a single shared
  // ceiling would have evicted the deliberate one several times over.
  for (let i = 0; i < LIMITS.autoCheckpoints * 2 + 3; i += 1) {
    await ok("desktop", "checkpoint", { name: `Scheduled snapshot ${i}`, auto: true });
  }
  const list = (await ok("desktop", "checkpoints", {})).checkpoints;
  assert.equal(list.filter((c) => c.auto).length, LIMITS.autoCheckpoints, `the scheduler keeps its own ${LIMITS.autoCheckpoints}`);
  assert.ok(list.some((c) => c.id === keep.checkpoint.id), "and the one you named is still there");
  assert.ok(list.length <= LIMITS.checkpoints);

  // The files go with the entries: a pruned checkpoint must not leave a state
  // on disk that nothing can reach.
  const dir = path.join(path.dirname(osPath(sandbox)), "checkpoints");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.equal(files.length, list.length, `one file per entry (${files.length} files, ${list.length} entries)`);
});

test("when the whole shelf is full, the scheduler's oldest goes first", async () => {
  await ok("desktop", "reset", {});
  // Fill it with deliberate states up to one short of the ceiling, plus one
  // automatic snapshot, then add another deliberate one.
  for (let i = 0; i < LIMITS.checkpoints - 1; i += 1) await ok("desktop", "checkpoint", { name: `mine ${i}` });
  const auto = await ok("desktop", "checkpoint", { name: "Scheduled snapshot", auto: true });
  const before = (await ok("desktop", "checkpoints", {})).checkpoints;
  assert.equal(before.length, LIMITS.checkpoints, "the shelf is full");

  await ok("desktop", "checkpoint", { name: "the newest one I meant" });
  const after = (await ok("desktop", "checkpoints", {})).checkpoints;
  assert.equal(after.length, LIMITS.checkpoints);
  assert.equal(after.some((c) => c.id === auto.checkpoint.id), false, "the scheduler's went, not yours");
  assert.equal(after.filter((c) => c.name === "mine 0").length, 1, "your oldest is still here");
  assert.ok(after.some((c) => c.name === "the newest one I meant"));
});

// ── and it really is the scheduler doing it ────────────────────────────────

test("the scheduler takes the snapshot, on your behalf and in the log", async () => {
  await ok("desktop", "reset", {});
  const before = (await ok("desktop", "checkpoints", {})).checkpoints.length;

  // Due immediately, repeating: exactly what the Settings action creates.
  const job = await ok("cron", "every", {
    intervalMs: 60_000,
    server: "desktop", tool: "checkpoint",
    args: { name: "Scheduled snapshot", auto: true },
  });
  assert.ok(job.id, "the schedule exists");

  const listed = (await ok("cron", "list", {})).jobs.find((j) => j.id === job.id);
  assert.ok(listed, "and the scheduler lists it");
  assert.equal(listed.server, "desktop");
  assert.equal(listed.tool, "checkpoint");
  assert.equal(listed.interval_ms, 60_000, "with the interval, in the field the row actually has");
  assert.ok(listed.due_at > 0, "and when it is next due");

  // Make it due, then let the runner run.
  openDb().prepare("UPDATE jobs SET due_at=? WHERE id=?").run(Date.now() - 1, job.id);
  await cronTick();

  const after = (await ok("desktop", "checkpoints", {})).checkpoints;
  assert.equal(after.length, before + 1, "the snapshot happened without anyone pressing anything");
  assert.equal(after.at(-1).auto, true, "and it is the scheduler's");

  // It is a Kernel call like any other, so it is in the audit log.
  const rows = queryAudit(sandbox.id, { server: "desktop", tool: "checkpoint", limit: 20 });
  assert.ok(rows.length >= 1, "the call is a row");
  assert.ok(rows.some((r) => r.result_kind === "ok"), "and it succeeded");

  // It comes round again rather than firing once.
  const rescheduled = (await ok("cron", "list", {})).jobs.find((j) => j.id === job.id);
  assert.ok(rescheduled.due_at > Date.now(), "the next one is scheduled");
  await ok("cron", "cancel", { id: job.id });
  assert.equal((await ok("cron", "list", {})).jobs.some((j) => j.id === job.id && j.enabled), false, "and it can be stopped");
});

test("a scheduled call can never exceed what the person who scheduled it holds", async () => {
  const { createTenant, createAccount, grant, grantsFor: grantsOf } = await import("../packages/control-db/src/registry.js");
  const t = createTenant("phase41-tenant");
  const narrow = createAccount(t.id, { username: "phase41-narrow", password: "pw" });
  grant(narrow.principalId, sandbox.id, "cron.every");
  grant(narrow.principalId, sandbox.id, "cron.list");
  const theirHeld = grantsOf(narrow.principalId, sandbox.id);

  const made = await kernel.call({
    principalId: narrow.principalId, heldPatterns: theirHeld,
    server: "cron", tool: "every",
    args: { intervalMs: 60_000, server: "desktop", tool: "checkpoint", args: { name: "sneaky", auto: true } },
  });
  assert.ok(made.ok, "scheduling is allowed — it changes nothing yet");

  const before = (await ok("desktop", "checkpoints", {})).checkpoints.length;
  openDb().prepare("UPDATE jobs SET due_at=? WHERE id=?").run(Date.now() - 1, made.result.id);
  await cronTick();
  const after = (await ok("desktop", "checkpoints", {})).checkpoints.length;
  assert.equal(after, before, "but firing it uses their capabilities, and they do not hold desktop.checkpoint");

  const denied = queryAudit(sandbox.id, { resultKind: "denied", limit: 30 });
  assert.ok(denied.some((r) => r.tool === "checkpoint"), "and the refusal is in the log");
  await ok("cron", "cancel", { id: made.result.id });
});

// ── the button that creates it ─────────────────────────────────────────────

test("Settings schedules it as a cron job, in minutes, and can stop it", () => {
  const settings = read("../apps/gateway/public/js/os/builtins.js");
  const fn = settings.split("async function scheduleSnapshots()")[1].split("async function stopSnapshots(")[0];
  assert.match(fn, /intervalMs: minutes \* 60_000/, "a person thinks in minutes; the tool takes milliseconds");
  assert.match(fn, /server: "desktop", tool: "checkpoint"/);
  assert.match(fn, /auto: true/, "and marks them as the scheduler's");
  assert.match(settings, /async function stopSnapshots\(id\)[\s\S]*?cron", "cancel"/, "and there is a way to stop it");
  assert.match(settings, /j\.server === "desktop" && j\.tool === "checkpoint"/, "the panel shows the schedules that exist");
  assert.match(settings, /c\.auto \? h\("span\.dim"/, "and marks the snapshots it made");
});

test("the Jobs schedule reads the fields the scheduler actually stores", () => {
  const ops = read("../apps/gateway/public/js/os/ops.js");
  assert.match(ops, /intervalMs: every \* 60_000/, "scheduling from Jobs sends milliseconds");
  assert.match(ops, /c\.interval_ms \?/, "and the row reads interval_ms");
  assert.match(ops, /c\.due_at \?/, "and due_at");
  assert.equal(/every_ms|next_at/.test(ops), false, "fields that were never in the table are gone");
});

// ── and a checkpoint does not vanish as a side effect ──────────────────────

test("a revert does not forget a checkpoint", async () => {
  await ok("desktop", "reset", {});
  await ok("desktop", "open", { app: "notes" });
  const { revisions } = await ok("desktop", "history", {});
  const mark = await ok("desktop", "checkpoint", { name: "before the undo" });
  await ok("desktop", "open", { app: "metrics" });

  // Reverting to a revision from before the checkpoint existed: the desktop
  // goes back, the checkpoint stays. It lives outside the revision window.
  await ok("desktop", "revert", { rev: revisions[0].rev });
  const after = (await ok("desktop", "checkpoints", {})).checkpoints;
  assert.ok(after.some((c) => c.id === mark.checkpoint.id), "the checkpoint survives an undo of the desktop");
  const restored = await ok("desktop", "checkpointRestore", { id: mark.checkpoint.id });
  assert.ok(restored.ok, "and it can still be restored");
});

test("replacing the machine sweeps the states nothing can reach any more", async () => {
  await ok("desktop", "reset", {});
  const dir = path.join(path.dirname(osPath(sandbox)), "checkpoints");
  const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);

  await ok("desktop", "checkpoint", { name: "one" });
  await ok("desktop", "checkpoint", { name: "two" });
  assert.equal(files(), 2, "two entries, two files");

  // A reset is the machine starting over: the index goes, and the documents
  // behind it are unreachable, so they go too rather than sitting on the volume
  // for its lifetime.
  await ok("desktop", "reset", {});
  assert.deepEqual((await doc()).checkpoints, []);
  assert.equal(files(), 0, "and no orphans are left behind");
});
