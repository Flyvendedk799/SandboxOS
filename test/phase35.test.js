// Phase 35: it holds, and it says what it costs.
//
// T1.9, T3.4, T3.5, T4.3 and T4.4 of goal.md. A machine you can back up and
// restore (and be told what a backup cannot bring back), an allowance you can
// see, per-call latency in the audit log, an app that cannot freeze the shell
// without saying so, and readings that report "unavailable" rather than zero.
import { readSource } from "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import {
  ensureSeed, grantsFor, recordModelUsage, modelUsage, verifyAuditChain, queryAudit, auditHash,
} from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { compareVolume } from "../packages/os/src/distro.js";

let kernel, owner, sandbox, tenant, held;
const call = (server, tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
const ok = async (server, tool, args) => { const r = await call(server, tool, args); assert.ok(r.ok, `${server}.${tool}: ${r.error}`); return r.result; };

test.before(async () => {
  openDb();
  ({ owner, sandbox, tenant } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  await ok("desktop", "reset", {});
});
test.after(() => { _resetKernels(); closeDb(); });

// ── T3.4 · a machine you can back up ────────────────────────────────────────

test("a backup carries the machine, not just its face", async () => {
  await ok("desktop", "appDefine", { id: "backed-up", name: "Backed Up", permissions: ["fs.read"] });
  await ok("desktop", "checkpoint", { name: "a good desktop" });
  await ok("desktop", "themeSet", { theme: "tide" });

  const { payload } = await ok("desktop", "machineExport", {});
  assert.equal(payload.kind, "machine");
  assert.ok(payload.os, "the desktop");
  assert.ok(payload.bundles.apps["backed-up"], "and the app's source");
  assert.ok(payload.manifest?.servers, "and which servers the Cell runs");
  assert.equal(payload.checkpoints.length, 1, "and the named states");
  assert.ok(payload.checkpoints[0].doc, "with their documents");
  assert.ok(payload.volume, "and a manifest of the volume");
  assert.ok(Array.isArray(payload.volume.files));
});

test("a restore plans before it acts, and says what a backup cannot bring back", async () => {
  const { payload } = await ok("desktop", "machineExport", {});
  // Wreck it.
  await ok("desktop", "reset", {});
  await ok("desktop", "themeSet", { theme: "sunset" });
  const wrecked = (await ok("desktop", "state", {})).doc;
  assert.equal(wrecked.apps["backed-up"], undefined);

  const planned = await ok("desktop", "machineRestore", { payload, plan: true });
  assert.equal(planned.applied, false, "a plan changes nothing");
  assert.equal((await ok("desktop", "state", {})).doc.theme.base, "sunset");
  assert.equal(planned.plan.apps, 1);
  assert.equal(planned.plan.checkpoints, 1);
  assert.ok(planned.plan.desktop.windows, "with a structural diff of the desktop");
  assert.match(planned.plan.note, /File contents are not in it/, "and honesty about what it is not");

  const done = await ok("desktop", "machineRestore", { payload });
  assert.equal(done.applied, true);
  const back = (await ok("desktop", "state", {})).doc;
  assert.equal(back.theme.base, "tide", "the desktop came back");
  assert.ok(back.apps["backed-up"], "with its apps");
  assert.equal(back.checkpoints.length, 1, "and its way back");
});

test("a volume manifest answers 'is this the machine I saved' in three ways", () => {
  const saved = [
    { path: "a.txt", size: 3, sha256: "aaa" },
    { path: "b/c.txt", size: 9, sha256: "bbb" },
    { path: "gone.txt", size: 1, sha256: "ccc" },
  ];
  const now = [
    { path: "a.txt", size: 3, sha256: "aaa" },
    { path: "b/c.txt", size: 9, sha256: "different" },
    { path: "new.txt", size: 2, sha256: "ddd" },
  ];
  const diff = compareVolume(saved, now);
  assert.deepEqual(diff.missing, ["gone.txt"]);
  assert.deepEqual(diff.changed, ["b/c.txt"]);
  assert.deepEqual(diff.added, ["new.txt"]);
  assert.equal(diff.files, 3);
});

test("a backup too large is refused rather than written", async () => {
  const huge = { payloadVersion: 1, os: { name: "x" }, bundles: { apps: { big: { "a.txt": "x".repeat(9 * 1024 * 1024) } } } };
  const r = await call("desktop", "machineRestore", { payload: huge });
  assert.equal(r.ok, false);
  assert.match(r.error, /too large/);
});

// ── T3.5 · the allowance, visible ───────────────────────────────────────────

test("kernel.limits says what may be used and what is being used", async () => {
  recordModelUsage({ tenantId: tenant.id, sandboxId: sandbox.id, provider: "anthropic", model: "claude-opus-5", tokens: 1200 });
  recordModelUsage({ tenantId: tenant.id, sandboxId: sandbox.id, provider: "openai", model: "gpt-5", tokens: 300 });

  const l = await ok("kernel", "limits", {});
  assert.ok(l.quota.agents >= 1, "a quota");
  assert.equal(typeof l.using.agentsRunning, "number");
  assert.equal(typeof l.using.sessions, "number");
  assert.equal(typeof l.using.volumeBytes, "number", "disk is measured, not guessed");
  assert.equal(l.model.total, 1500);
  assert.equal(l.model.byModel.length, 2);
  // Tokens rather than money, and it says so instead of leaving someone to
  // mistake a number for a bill.
  assert.match(l.model.note, /tokens, not money/);
  assert.equal(l.model.windowDays, 30);
});

test("model usage is recorded per provider and windowed", () => {
  const long = modelUsage(tenant.id, { since: 0 });
  assert.ok(long.total >= 1500);
  const empty = modelUsage(tenant.id, { since: Date.now() + 60_000 });
  assert.equal(empty.total, 0, "a window with nothing in it is zero, not everything");
  assert.equal(recordModelUsage({ tenantId: tenant.id, provider: "anthropic", tokens: 0 }), null, "nothing to record is not a row");
});

// ── T1.9 · latency, in the log where everything else already is ─────────────

test("every call records how long it took, and the chain still verifies", async () => {
  await ok("desktop", "state", {});
  await ok("proc", "exec", { cmd: "echo timed" });
  const rows = queryAudit(sandbox.id, { limit: 20 });
  const timed = rows.filter((r) => r.ms != null);
  assert.ok(timed.length >= 2, `calls carry a duration (${timed.length} of ${rows.length})`);
  assert.ok(timed.every((r) => r.ms >= 0));
  // The hash covers it, and one function defines what the hash covers.
  const v = verifyAuditChain();
  assert.equal(v.ok, true, `chain intact (${v.brokenAtId ?? "-"})`);
  const one = rows.at(-1);
  assert.equal(auditHash(one, one.prev_hash ?? ""), one.hash, "the row hashes to what it stores");
});

test("the rollup answers how often, how badly and how slowly, per tool", async () => {
  for (let i = 0; i < 3; i += 1) await ok("desktop", "state", {});
  await call("fs", "list", { path: "." }); // denied: no grants passed
  const act = await ok("metrics", "activity", { windowMs: 3_600_000 });
  const state = act.byTool.find((t) => t.server === "desktop" && t.tool === "state");
  assert.ok(state.n >= 3);
  assert.equal(typeof state.denied, "number");
  assert.equal(typeof state.errors, "number");
  assert.ok(Array.isArray(act.slowest), "and the slowest individual calls are their own list");
  const recent = await ok("metrics", "recent", { limit: 5 });
  assert.ok(recent.events.some((e) => e.ms != null), "recent events carry it too");
});

// ── T4.4 · a reading nothing could take says so ─────────────────────────────

test("metrics says when it could not measure, instead of reporting zero", async () => {
  const before = process.env.SANDBOXOS_SHELL;
  const { _resetShell } = await import("../packages/cell/src/shell.js");
  try {
    process.env.SANDBOXOS_SHELL = "/definitely/not/a/shell";
    _resetShell();
    const snap = await ok("metrics", "snapshot", {});
    assert.ok(snap.unavailable, "the snapshot admits it");
    assert.match(snap.unavailable, /cannot run commands|could not be measured|not an executable/);
    assert.equal(snap.load, null, "and does not invent a load");
  } finally {
    if (before === undefined) delete process.env.SANDBOXOS_SHELL; else process.env.SANDBOXOS_SHELL = before;
    _resetShell();
  }
});

test("a port scan that could not look is not an empty machine", async () => {
  const before = process.env.SANDBOXOS_SHELL;
  const { _resetShell } = await import("../packages/cell/src/shell.js");
  try {
    process.env.SANDBOXOS_SHELL = "/definitely/not/a/shell";
    _resetShell();
    const scan = await ok("ports", "scan", {});
    assert.deepEqual(scan.listening, []);
    assert.ok(scan.unavailable, "it says it could not look");
    assert.ok(Array.isArray(scan.tried), "and what it tried");
  } finally {
    if (before === undefined) delete process.env.SANDBOXOS_SHELL; else process.env.SANDBOXOS_SHELL = before;
    _resetShell();
  }
});

// ── T4.3 · an app cannot freeze the shell in silence ────────────────────────

test("the shell pings every frame and reports one that stops answering", () => {
  const frames = readSource(new URL("../apps/gateway/public/js/os/frames.js", import.meta.url));
  assert.match(frames, /const PING_MS/, "there is a watchdog");
  assert.match(frames, /export function onFrameHealth/, "it can be watched");
  assert.match(frames, /case "pong":/, "the answer is a message, not a guess");
  assert.match(frames, /if \(document\.hidden\) return;/, "a background tab is not a stuck app");

  const bridge = readSource(new URL("../apps/gateway/public/js/os/bridge.js", import.meta.url));
  assert.match(bridge, /m\.event === "ping"/, "and the frame answers it");

  const wm = readSource(new URL("../apps/gateway/public/js/os/wm.js", import.meta.url));
  assert.match(wm, /function paintStuck/, "a card, not a dead rectangle");
  assert.match(wm, /Reload it/);
  assert.match(wm, /Open its source/);
  assert.match(wm, /Close the window/);
});
