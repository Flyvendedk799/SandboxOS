// Phase 34: control you can feel.
//
// Track 3 (and T2.4) of goal.md: a desktop you can name and come back to, a
// keyboard that is a document field rather than a hardcoded list, and attention
// that belongs to the person rather than to whatever wants to interrupt them.
import { readSource } from "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { normalizeDoc, LIMITS } from "../packages/os/src/schema.js";
import { osPath } from "../packages/os/src/store.js";
import { notifyOs } from "../packages/os/src/notify.js";
import {
  KEY_ACTIONS, DEFAULT_KEYS, isChord, cleanKeys, matchesChord, prettyChord,
} from "../packages/os/src/keys.js";

let kernel, owner, sandbox, held;
const call = (tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server: "desktop", tool, args });
const ok = async (tool, args) => { const r = await call(tool, args); assert.ok(r.ok, `desktop.${tool}: ${r.error}`); return r.result; };

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  await ok("reset", {});
});
test.after(() => { _resetKernels(); closeDb(); });

// ── T2.4 · checkpoints ──────────────────────────────────────────────────────

test("a checkpoint is a named desktop you can come back to", async () => {
  await ok("themeSet", { theme: "midnight" });
  const saved = await ok("checkpoint", { name: "before the redesign" });
  assert.equal(saved.checkpoint.name, "before the redesign");

  // Change the world.
  await ok("themeSet", { theme: "aurora" });
  await ok("open", { app: "notes" });
  const midway = (await ok("state", {})).doc;
  assert.equal(midway.theme.base, "aurora");

  // The diff says what happened since, structurally.
  const { diff } = await ok("checkpointDiff", { id: saved.checkpoint.id });
  assert.equal(diff.windows.added, 1);
  assert.deepEqual(diff.theme, ["base"]);

  // And going back is one call — and itself a revision, so it can be undone.
  const restored = await ok("checkpointRestore", { id: saved.checkpoint.id });
  const back = (await ok("state", {})).doc;
  assert.equal(back.theme.base, "midnight");
  assert.equal(back.rev, restored.rev);
  assert.ok(back.rev > midway.rev, "the restore moves history forward, not back");
  assert.equal(back.checkpoints.length, 1, "and the way back is not deleted by using it");
});

test("a checkpoint survives history being pruned", async () => {
  const saved = await ok("checkpoint", { name: "keep me" });
  // Push more revisions than the history keeps.
  for (let i = 0; i < LIMITS.history + 3; i += 1) await ok("rename", { name: `churn-${i}` });
  const list = await ok("checkpoints", {});
  assert.ok(list.checkpoints.some((c) => c.id === saved.checkpoint.id), "it is still listed");
  const r = await ok("checkpointRestore", { id: saved.checkpoint.id });
  assert.ok(r.ok, "and still restorable — the copy is outside the window");
});

test("checkpoints are bounded, and forgetting one deletes its copy", async () => {
  const dir = path.join(path.dirname(osPath(sandbox)), "checkpoints");
  const made = [];
  for (let i = 0; i < LIMITS.checkpoints + 3; i += 1) made.push((await ok("checkpoint", { name: `c${i}` })).checkpoint);
  const list = (await ok("checkpoints", {})).checkpoints;
  assert.equal(list.length, LIMITS.checkpoints, "the index is bounded");
  const dropped = made[0];
  assert.equal(fs.existsSync(path.join(dir, `${dropped.id}.json`)), false, "and the pruned copy is gone from disk");

  const keep = list.at(-1);
  await ok("checkpointRemove", { id: keep.id });
  assert.equal(fs.existsSync(path.join(dir, `${keep.id}.json`)), false);
  const gone = await call("checkpointRestore", { id: keep.id });
  assert.equal(gone.ok, false);
});

test("a checkpoint needs a name, and an unknown one is refused", async () => {
  for (const [args, expected] of [
    [{ name: "   " }, /needs a name/],
  ]) {
    const r = await call("checkpoint", args);
    assert.equal(r.ok, false);
    assert.match(r.error, expected);
  }
  assert.equal((await call("checkpointDiff", { id: "cp_nope" })).ok, false);
  assert.equal((await call("checkpointRemove", { id: "cp_nope" })).ok, false);
});

// ── T3.2 · the keyboard is a document field ─────────────────────────────────

test("the keymap is in the document, complete, and readable", async () => {
  const listed = await ok("keyList", {});
  assert.equal(Object.keys(listed.keys).length, Object.keys(DEFAULT_KEYS).length);
  for (const { action, what, chord } of listed.actions) {
    assert.ok(KEY_ACTIONS[action], `${action} is a known action`);
    assert.ok(what.length > 3, "with a sentence a cheat sheet can print");
    assert.ok(chord === null || isChord(chord), `${action}'s chord is readable`);
  }
});

test("a rebinding is a document write, and a collision is refused", async () => {
  const r = await ok("keySet", { action: "spotlight", chord: "mod+shift+Space" });
  assert.equal(r.keys.spotlight, "mod+shift+Space");
  assert.equal((await ok("state", {})).doc.shell.keys.spotlight, "mod+shift+Space");

  const clash = await call("keySet", { action: "closeWindow", chord: "mod+shift+Space" });
  assert.equal(clash.ok, false, "two actions cannot hold one chord");
  assert.match(clash.error, /already spotlight/);

  const nonsense = await call("keySet", { action: "spotlight", chord: "wiggle the mouse" });
  assert.equal(nonsense.ok, false);
  assert.match(nonsense.error, /not a chord/);

  const unknown = await call("keySet", { action: "makeCoffee", chord: "mod+c" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown keyboard action/);

  // Unbind, then restore every default.
  await ok("keySet", { action: "spotlight", chord: null });
  assert.equal((await ok("state", {})).doc.shell.keys.spotlight, null, "unbound is a value, not an absence");
  await ok("keySet", {});
  assert.equal((await ok("state", {})).doc.shell.keys.spotlight, DEFAULT_KEYS.spotlight);
});

test("the chord grammar matches events the way a shell needs", () => {
  const ev = (o) => ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });
  assert.ok(matchesChord("mod+k", ev({ metaKey: true, key: "k" })));
  assert.ok(matchesChord("mod+k", ev({ ctrlKey: true, key: "K" })), "mod is ⌘ or Ctrl, and case is not a modifier");
  assert.ok(!matchesChord("mod+k", ev({ key: "k" })), "a bare key is not the chord");
  assert.ok(matchesChord("mod+shift+d", ev({ metaKey: true, shiftKey: true, key: "D" })));
  assert.ok(!matchesChord("mod+shift+d", ev({ metaKey: true, key: "d" })));
  assert.ok(matchesChord("mod+ArrowLeft", ev({ metaKey: true, key: "ArrowLeft" })));
  assert.ok(matchesChord("?", ev({ shiftKey: true, key: "?" })), "a shifted character does not have to name shift");
  assert.equal(prettyChord("mod+shift+k"), "⌘⇧K");
  assert.equal(prettyChord("mod+ArrowLeft"), "⌘←");
  assert.equal(cleanKeys({ spotlight: "nope nope" }).spotlight, DEFAULT_KEYS.spotlight, "an unreadable chord is dropped, not stored");
  assert.equal(cleanKeys({ spotlight: null }).spotlight, null, "and null survives as 'deliberately unbound'");
});

test("the shell reads the map rather than a hardcoded list", () => {
  const shell = readSource(new URL("../apps/gateway/public/js/os/shell.js", import.meta.url));
  assert.match(shell, /import \{ KEY_ACTIONS, matchesChord, prettyChord \} from "\.\/lib\/keys\.js"/);
  assert.match(shell, /function actionFor\(e\)/, "one place decides which action a key is");
  assert.match(shell, /const keys = os\.doc\?\.shell\?\.keys \?\? \{\}/, "and it reads the document");
  // The cheat sheet is generated, so a remap cannot make it lie.
  assert.match(shell, /Object\.entries\(KEY_ACTIONS\)\s*\n?\s*\.filter\(\(\[action\]\) => keys\[action\]\)/);
});

// ── T3.3 · attention is yours ───────────────────────────────────────────────

test("do-not-disturb records everything and interrupts with nothing", async () => {
  await ok("shellSet", { notifications: { dnd: true, allow: ["agents"] } });

  notifyOs(sandbox, { app: "Processes", source: "procs", title: "a build finished" });
  notifyOs(sandbox, { app: "Agents", source: "agents", title: "the agent came back" });

  const list = (await ok("state", {})).doc.notifications;
  const build = list.find((n) => n.title === "a build finished");
  const agent = list.find((n) => n.title === "the agent came back");
  assert.ok(build && agent, "both are recorded — nothing is thrown away");
  assert.equal(build.quiet, true, "the build does not interrupt");
  assert.equal(agent.quiet, undefined, "the agent still does, because it is allowed");
  assert.equal(agent.source, "agents");

  await ok("shellSet", { notifications: { dnd: false } });
  notifyOs(sandbox, { app: "Processes", source: "procs", title: "another build" });
  const after = (await ok("state", {})).doc.notifications.find((n) => n.title === "another build");
  assert.equal(after.quiet, undefined, "with the switch off, everything is loud again");
});

test("the allow list is closed, and normalization keeps it that way", async () => {
  await ok("shellSet", { notifications: { allow: ["agents", "procs", "nonsense"] } });
  const shell = (await ok("state", {})).doc.shell.notifications;
  assert.deepEqual(shell.allow, ["agents", "procs"]);
  const doc = normalizeDoc({ shell: { notifications: { dnd: "yes", allow: "everything" } } });
  assert.equal(doc.shell.notifications.dnd, false, "a non-boolean is not a boolean");
  assert.deepEqual(doc.shell.notifications.allow, ["agents"], "and a non-list falls back to the default");
});

test("the switch is reachable from the keyboard and says which way it went", () => {
  const shell = readSource(new URL("../apps/gateway/public/js/os/shell.js", import.meta.url));
  assert.match(shell, /toggleDnd: \(\) => \{/);
  assert.match(shell, /Everything is still recorded/, "and it explains what it does");
  assert.match(shell, /class: dnd \? "dnd" : ""/, "the bell shows the state");
});
