// Phase 50: supervised means supervised across a restart.
//
// Reaping orphans (phase 49) fixed a job that survived its Gateway invisibly —
// running, unstoppable, holding its port, absent from every list. But the job
// table had always been a Map in one process's memory, so removing the invisible
// half would have left nothing at all: an empty Jobs list and a dead dev server,
// every deploy.
//
// That is only half a fix, and the missing half is the one the word promises. A
// supervised process is something looked after across the life of the *machine*,
// not the life of whichever process happens to be looking after it. So the list
// is written down beside the volume, and adopting a Sandbox brings back what was
// running under the ids it had.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { jobsPath, loadJobs, saveJobs, clearJobs, MAX_REMEMBERED } from "../packages/kernel/src/servers/job-store.js";
import {
  restoreJobs, stopAllProcsEverywhere, _resetJobRestore,
} from "../packages/kernel/src/servers/proc.js";

let kernel, owner, sandbox, held;
const call = (srv, tool, args = {}) =>
  kernel.call({ principalId: owner.id, heldPatterns: held, server: srv, tool, args });
const ok = async (srv, tool, args) => {
  const r = await call(srv, tool, args);
  assert.ok(r.ok, `${srv}.${tool}: ${r.error}`);
  return r.result;
};
const until = async (fn, ms = 10_000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
});
test.after(() => { stopAllProcsEverywhere(); clearJobs(sandbox); _resetKernels(); closeDb(); });

// ── the file ───────────────────────────────────────────────────────────────

test("the list lives beside the volume, not inside it", () => {
  // The user's files are the user's. This is the machine's own bookkeeping, and
  // it should no more appear in Files than the desktop document does.
  assert.ok(!jobsPath(sandbox).startsWith(sandbox.volume_path),
    `${jobsPath(sandbox)} is inside ${sandbox.volume_path}`);
  assert.match(jobsPath(sandbox), /jobs\.json$/);
});

test("what survives is the job, not its output", () => {
  saveJobs(sandbox, [{
    id: "j1", name: "dev", cmd: "npm run dev", timeoutMs: 5000,
    state: "running", startedAt: 1000,
    logs: [{ ts: 1, stream: "stdout", text: "listening" }], pending: "half a li",
    handle: { kill() {} }, pid: 4242,
  }]);
  const [back] = loadJobs(sandbox);
  assert.deepEqual(back, {
    id: "j1", name: "dev", cmd: "npm run dev", timeoutMs: 5000,
    state: "running", code: null, startedAt: 1000, exitedAt: null,
  });
  // The logs belonged to a process that no longer exists; a restored job starts
  // a new log rather than pretending to continue an old one. And a handle is a
  // reference into a dead process's memory — the one thing that must not persist.
  assert.ok(!("logs" in back) && !("handle" in back) && !("pid" in back));
  clearJobs(sandbox);
});

test("a file that cannot be read is an empty list, not a boot failure", () => {
  fs.writeFileSync(jobsPath(sandbox), "{ this is not json");
  assert.deepEqual(loadJobs(sandbox), [], "the cost of forgetting is one Jobs list");
  fs.writeFileSync(jobsPath(sandbox), JSON.stringify({ v: 1, jobs: [{ id: "x" }, null, { cmd: "y" }, 7] }));
  assert.deepEqual(loadJobs(sandbox), [], "and an entry that is not a job is not a job");
  clearJobs(sandbox);
  assert.deepEqual(loadJobs(sandbox), []);
});

test("history is bounded; what is running never is", () => {
  const finished = Array.from({ length: MAX_REMEMBERED + 20 }, (_, i) => ({
    id: `old${i}`, name: "x", cmd: "x", state: "exited", code: 0, startedAt: i, exitedAt: i, logs: [],
  }));
  const running = Array.from({ length: 5 }, (_, i) => ({
    id: `run${i}`, name: "x", cmd: "x", state: "running", startedAt: 1, logs: [],
  }));
  saveJobs(sandbox, [...finished, ...running]);
  const back = loadJobs(sandbox);
  assert.equal(back.filter((j) => j.state === "running").length, 5,
    "a machine with sixty things running keeps all sixty");
  assert.equal(back.filter((j) => j.state !== "running").length, MAX_REMEMBERED);
  // Newest kept, oldest dropped.
  assert.ok(back.some((j) => j.id === `old${MAX_REMEMBERED + 19}`));
  assert.ok(!back.some((j) => j.id === "old0"));
  clearJobs(sandbox);
});

// ── the round trip ─────────────────────────────────────────────────────────

test("a running job is written down as soon as it starts", async () => {
  const job = await ok("proc", "start", { cmd: "sleep 30", name: "written" });
  const saved = loadJobs(sandbox).find((j) => j.id === job.id);
  assert.ok(saved, "it is on disk before the call that started it returns");
  assert.equal(saved.state, "running");
  assert.equal(saved.cmd, "sleep 30");
  await ok("proc", "stop", { id: job.id });
});

test("stopping something is a decision, and it outlives the Gateway too", async () => {
  const job = await ok("proc", "start", { cmd: "sleep 30", name: "stopped-on-purpose" });
  await ok("proc", "stop", { id: job.id });
  const saved = loadJobs(sandbox).find((j) => j.id === job.id);
  assert.equal(saved.state, "stopped",
    "otherwise the next boot helpfully starts the very thing you just turned off");
});

test("a job that ends on its own is remembered as having ended", async () => {
  const job = await ok("proc", "start", { cmd: "exit 7", name: "brief" });
  assert.ok(await until(async () => (await ok("proc", "logs", { id: job.id })).state !== "running"));
  const saved = loadJobs(sandbox).find((j) => j.id === job.id);
  assert.equal(saved.state, "failed");
  assert.equal(saved.code, 7);
  await ok("proc", "forget", { id: job.id });
  assert.ok(!loadJobs(sandbox).some((j) => j.id === job.id), "and forgetting it forgets it");
});

// ── the restart ────────────────────────────────────────────────────────────

test("what was running comes back, under the id it had", async () => {
  const job = await ok("proc", "start", { cmd: "sleep 30", name: "survivor" });
  const before = await ok("proc", "jobs");
  assert.ok(before.jobs.some((j) => j.id === job.id && j.state === "running"));

  // A Gateway going away: the processes die, the table goes with them, the file
  // stays. (This is the *tidy* exit; a SIGKILL leaves the same file behind and
  // orphans.js deals with what it leaves running.)
  stopAllProcsEverywhere();
  assert.deepEqual((await ok("proc", "jobs")).jobs, [], "the table is empty, as after a restart");

  _resetJobRestore();
  const r = await restoreJobs(kernel.cell, sandbox);
  assert.equal(r.restored, 1);
  const after = await ok("proc", "jobs");
  const again = after.jobs.find((j) => j.id === job.id);
  assert.ok(again, "the same id, so anything that referred to it still does");
  assert.equal(again.state, "running");
  assert.equal(again.cmd, "sleep 30");
  assert.notEqual(again.pid, null, "and it is a real process, not a row in a list");
  await ok("proc", "stop", { id: job.id });
});

test("what had finished comes back as history, so the list is not blank", async () => {
  clearJobs(sandbox);
  saveJobs(sandbox, [
    { id: "done1", name: "build", cmd: "make", state: "exited", code: 0, startedAt: 1, exitedAt: 2, logs: [] },
    { id: "done2", name: "test", cmd: "npm test", state: "failed", code: 1, startedAt: 3, exitedAt: 4, logs: [] },
  ]);
  _resetJobRestore();
  const r = await restoreJobs(kernel.cell, sandbox);
  assert.equal(r.restored, 0, "nothing that had stopped is started again");
  const jobs = (await ok("proc", "jobs")).jobs;
  assert.ok(jobs.some((j) => j.id === "done1" && j.state === "exited"));
  assert.ok(jobs.some((j) => j.id === "done2" && j.state === "failed" && j.code === 1));
  // Their logs went with the Gateway that captured them, and an empty tail would
  // read like a process that printed nothing.
  const tail = await ok("proc", "logs", { id: "done1" });
  assert.deepEqual(tail.logs, []);
  await ok("proc", "forget", { id: "done1" });
  await ok("proc", "forget", { id: "done2" });
});

test("a command that cannot be restarted becomes a failure you can read", async () => {
  clearJobs(sandbox);
  saveJobs(sandbox, [{ id: "gone", name: "x", cmd: "sleep 30", state: "running", startedAt: 1, logs: [] }]);
  _resetJobRestore();
  const broken = { ...kernel.cell, ensureRunning: async () => { throw new Error("no such Cell"); } };
  const r = await restoreJobs(broken, sandbox);
  assert.equal(r.restored, 0);
  const rec = (await ok("proc", "jobs")).jobs.find((j) => j.id === "gone");
  assert.ok(rec, "the entry is not quietly lost");
  assert.equal(rec.state, "failed");
  assert.match(rec.failure, /could not restart: no such Cell/);
  await ok("proc", "forget", { id: "gone" });
  clearJobs(sandbox);
});

test("restore happens once, however many times the server set is rebuilt", async () => {
  clearJobs(sandbox);
  saveJobs(sandbox, [{ id: "once", name: "x", cmd: "sleep 30", state: "running", startedAt: 1, logs: [] }]);
  _resetJobRestore();
  const first = await restoreJobs(kernel.cell, sandbox);
  assert.equal(first.restored, 1);
  // The Kernel rebuilds its servers whenever the manifest changes. Restarting
  // everything on each rebuild would be a fork bomb with a calendar.
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(await restoreJobs(kernel.cell, sandbox), { restored: 0, remembered: 0 });
  }
  assert.equal((await ok("proc", "jobs")).jobs.filter((j) => j.id === "once").length, 1);
  await ok("proc", "stop", { id: "once" });
  clearJobs(sandbox);
});

test("restore never starts a job before the Cell has been adopted", async () => {
  // Ordering that is load-bearing and free: startJob awaits ensureRunning, and
  // that is where a Cell inherited from a dead Gateway is emptied of orphans. A
  // restored dev server must not race its predecessor's corpse for the port.
  clearJobs(sandbox);
  saveJobs(sandbox, [{ id: "ordered", name: "x", cmd: "sleep 30", state: "running", startedAt: 1, logs: [] }]);
  _resetJobRestore();
  const order = [];
  const watched = {
    ...kernel.cell,
    ensureRunning: async () => { order.push("adopt"); return kernel.cell.ensureRunning(); },
    execStream: (...a) => { order.push("start"); return kernel.cell.execStream(...a); },
  };
  await restoreJobs(watched, sandbox);
  assert.deepEqual(order, ["adopt", "start"]);
  await ok("proc", "stop", { id: "ordered" });
  clearJobs(sandbox);
});

test("a Sandbox with nothing written down restores nothing and says so", async () => {
  clearJobs(sandbox);
  _resetJobRestore();
  assert.deepEqual(await restoreJobs(kernel.cell, sandbox), { restored: 0, remembered: 0 });
});

test("deleting a machine forgets what it was running", () => {
  const server = fs.readFileSync(new URL("../apps/gateway/src/server.js", import.meta.url), "utf8");
  assert.match(server, /forgetJobs\(sb\);/,
    "the list is a sibling of the volume, so removing the volume does not remove it");
});
