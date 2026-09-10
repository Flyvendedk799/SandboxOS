// Phase 45: destroy it, and build it again from the file.
//
// T3.4 of goal.md ends with an instruction rather than a feature: "prove it by
// destroying a Sandbox and rebuilding it from the export alone". `phase35`
// checked that a backup carries the right things and that a restore plans before
// it acts. This is the harder version — the machine is *gone*, and what comes
// back has to come out of the payload and nothing else.
//
// It also pins the honest half. A backup carries a manifest of the volume, not
// its contents: names, sizes and hashes. So the rebuilt machine has the desktop,
// the apps, the composition and the checkpoints, and it can say exactly which
// files it is missing — which is worth more than a restore that silently hands
// you a machine with holes in it.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, createSandboxForTenant } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { destroyOs, osPath, loadOs, forgetOs } from "../packages/os/src/store.js";
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

test("a destroyed machine comes back from its backup alone", async () => {
  // ── 1 · a machine worth losing ────────────────────────────────────────────
  await ok("desktop", "rename", { name: "the-one-that-was-lost" });
  await ok("desktop", "themeSet", { theme: "tide" });
  await ok("desktop", "appDefine", {
    id: "survivor", name: "Survivor", permissions: ["fs.read"],
    files: { "index.html": "<!doctype html><p id=alive>still here", "app.css": "p { color: teal }" },
  });
  await ok("desktop", "open", { app: "survivor" });
  await ok("desktop", "widgetAdd", { kind: "clock" });
  await ok("desktop", "workspaceAdd", { name: "Second" });
  await ok("desktop", "checkpoint", { name: "before the disaster" });
  await ok("fs", "write", { path: "work/notes.md", content: "# work\nsomething I wrote\n" });

  const original = (await ok("desktop", "state", {})).doc;
  const { payload } = await ok("desktop", "machineExport", {});

  // The payload is the only thing that survives. Prove it is self-contained by
  // reading nothing else after this point.
  const backup = JSON.parse(JSON.stringify(payload));
  assert.ok(backup.os && backup.bundles && backup.checkpoints && backup.volume, "the file has all four parts");

  // ── 2 · destroy it ────────────────────────────────────────────────────────
  const osDir = path.dirname(osPath(sandbox));
  assert.ok(fs.existsSync(osDir), "the machine's desktop is on disk");
  destroyOs(sandbox);
  assert.equal(fs.existsSync(osDir), false, "and now it is not");

  // A fresh Sandbox for the same tenant: a new volume, a new document, nothing
  // in common with the old one but the payload.
  const rebuilt = createSandboxForTenant(tenant.id, owner.id, {
    slug: "rebuilt-from-backup", name: "empty", cellBackend: "local",
  });
  const rebuiltKernel = await getKernel(rebuilt);
  const rebuiltHeld = grantsFor(owner.id, rebuilt.id);
  const there = async (server, tool, args = {}) => {
    const r = await rebuiltKernel.call({ principalId: owner.id, heldPatterns: rebuiltHeld, server, tool, args });
    assert.ok(r.ok, `${server}.${tool}: ${r.error}`);
    return r.result;
  };
  const fresh = (await there("desktop", "state", {})).doc;
  assert.notEqual(fresh.name, original.name, "it starts as somebody else's machine");
  assert.equal(fresh.apps.survivor, undefined);

  // ── 3 · read the plan before acting on it ─────────────────────────────────
  const planned = await there("desktop", "machineRestore", { payload: backup, plan: true });
  assert.equal(planned.applied, false, "a plan is still not a restore");
  assert.equal(planned.plan.apps, 1, "it says what would arrive");
  assert.equal(planned.plan.checkpoints, 1);
  assert.ok(planned.plan.volume, "and what the volume is expected to hold");
  assert.match(planned.plan.note, /File contents are not in it/i);

  // ── 4 · rebuild ──────────────────────────────────────────────────────────
  const done = await there("desktop", "machineRestore", { payload: backup });
  assert.equal(done.applied, true);

  const back = (await there("desktop", "state", {})).doc;
  assert.equal(back.name, "the-one-that-was-lost", "the machine is itself again");
  assert.equal(back.theme.base, "tide", "wearing what it wore");
  assert.ok(back.apps.survivor, "with the app it had");
  assert.deepEqual(back.apps.survivor.permissions, ["fs.read"], "and what that app may do");
  assert.equal(back.windows.filter((w) => w.app === "survivor").length, 1, "the window it had open");
  assert.equal(back.widgets.length, original.widgets.length, "its widgets");
  assert.equal(back.workspaces.length, 2, "and both workspaces");
  assert.equal(back.checkpoints.length, 1, "and the way back it had saved");

  // The app's *source* came back, not just its name — the thing that makes a
  // backup a machine rather than a screenshot of one.
  const file = await there("desktop", "appRead", { id: "survivor", path: "index.html" });
  assert.match(file.content, /id=alive/, "byte for byte");
  const files = await there("desktop", "appFiles", { id: "survivor" });
  assert.deepEqual(files.files.map((f) => f.path).sort(), ["app.css", "index.html"]);

  // And the checkpoint restores, on the rebuilt machine, to the state it named.
  const cp = (await there("desktop", "checkpoints", {})).checkpoints[0];
  assert.equal(cp.name, "before the disaster");
  const restored = await there("desktop", "checkpointRestore", { id: cp.id });
  assert.ok(restored.ok, "the way back came back too");
});

test("and it is honest about the one thing a backup cannot carry", async () => {
  // The volume manifest is names, sizes and hashes. A rebuilt machine can
  // therefore say precisely which files it is missing — which is the useful
  // answer, and much better than a restore that pretends.
  const rebuilt = createSandboxForTenant(tenant.id, owner.id, {
    slug: "rebuilt-honest", name: "empty", cellBackend: "local",
  });
  const rebuiltKernel = await getKernel(rebuilt);
  const rebuiltHeld = grantsFor(owner.id, rebuilt.id);
  const there = async (server, tool, args = {}) => {
    const r = await rebuiltKernel.call({ principalId: owner.id, heldPatterns: rebuiltHeld, server, tool, args });
    assert.ok(r.ok, `${server}.${tool}: ${r.error}`);
    return r.result;
  };

  // A machine with one file in its volume, backed up, restored elsewhere.
  await there("fs", "write", { path: "kept.txt", content: "this one exists\n" });
  const { payload } = await there("desktop", "machineExport", {});
  const saved = payload.volume.files;
  assert.ok(saved.some((f) => f.path.replace(/\\/g, "/") === "kept.txt"), "the manifest lists it");
  assert.ok(saved.every((f) => typeof f.sha256 === "string" && f.sha256.length === 64), "with a hash, not its contents");
  assert.equal(JSON.stringify(payload).includes("this one exists"), false, "the bytes are not in the file");

  // Restored onto a machine that never had the file: the comparison says so
  // rather than the restore claiming success.
  const elsewhere = createSandboxForTenant(tenant.id, owner.id, {
    slug: "rebuilt-elsewhere", name: "empty", cellBackend: "local",
  });
  const elseKernel = await getKernel(elsewhere);
  const elseHeld = grantsFor(owner.id, elsewhere.id);
  const plan = await elseKernel.call({
    principalId: owner.id, heldPatterns: elseHeld,
    server: "desktop", tool: "machineRestore", args: { payload, plan: true },
  });
  assert.ok(plan.ok);
  assert.ok(plan.result.plan.volume.missing.some((p) => p.replace(/\\/g, "/") === "kept.txt"),
    "the plan names the file the manifest expects and this machine does not have");

  // compareVolume is the same question asked directly, in three answers.
  const verdict = compareVolume(saved, [{ path: "kept.txt", size: 1, sha256: "different" }, { path: "extra.txt", size: 2, sha256: "x" }]);
  assert.deepEqual(verdict.missing, [], "nothing missing");
  assert.deepEqual(verdict.changed, ["kept.txt"], "one changed");
  assert.deepEqual(verdict.added, ["extra.txt"], "one that was not in the backup");
});

test("destroying a machine takes its desktop, its history and its bundles", async () => {
  const doomed = createSandboxForTenant(tenant.id, owner.id, {
    slug: "doomed-machine", name: "doomed", cellBackend: "local",
  });
  const k = await getKernel(doomed);
  const h = grantsFor(owner.id, doomed.id);
  const there = async (server, tool, args = {}) => {
    const r = await k.call({ principalId: owner.id, heldPatterns: h, server, tool, args });
    assert.ok(r.ok, `${server}.${tool}: ${r.error}`);
    return r.result;
  };
  await there("desktop", "appDefine", { id: "gone-soon", name: "Gone", files: { "index.html": "<p>bye" } });
  await there("desktop", "checkpoint", { name: "pointless" });
  await there("desktop", "open", { app: "gone-soon" });

  const dir = path.dirname(osPath(doomed));
  assert.ok(fs.existsSync(path.join(dir, "history")), "there is a history");
  assert.ok(fs.existsSync(path.join(dir, "checkpoints")), "and checkpoints");
  assert.ok(fs.existsSync(path.join(dir, "apps", "gone-soon")), "and an app's source");

  destroyOs(doomed);
  assert.equal(fs.existsSync(dir), false, "all of it goes at once");

  // And the machine is a first-run machine again if anyone opens it, rather
  // than a broken one.
  forgetOs(doomed.id);
  const seeded = loadOs(doomed);
  assert.ok(seeded.windows.length >= 1, "opening it seeds a desktop rather than failing");
  assert.equal(seeded.apps["gone-soon"], undefined);
  assert.equal(seeded.setup.done, false, "and it is a new machine, so it asks");
});
