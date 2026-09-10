// Phase 37: what the day found.
//
// `scripts/day.mjs` is acceptance A of goal.md §10 — the ten-step day driven
// through a real browser. Writing it turned two assumptions into defects, and
// these are the tests that hold the fixes down:
//
//   · An undo could only rewind the whole document. "Apply the agent's change,
//     then undo the alignment only" was in the specification and was not
//     possible: reverting past the alignment also took back the widget added
//     after it. `revert` now takes `only: [...]`.
//   · Ending a shell session left what the shell had started still running.
//     `kill()` asked killTree to walk the tree *and* killed our own child in the
//     same breath; on Windows `taskkill /T` reads the tree when it runs, so the
//     dev server was orphaned and kept its port.
import { readSource } from "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { attachSession, killSession, killAllSessions } from "../packages/kernel/src/pty-sessions.js";
import { REVERT_SCOPES } from "../packages/os/src/store.js";

let kernel, owner, sandbox, held;
const call = (server, tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
const ok = async (server, tool, args) => { const r = await call(server, tool, args); assert.ok(r.ok, `${server}.${tool}: ${r.error}`); return r.result; };
const doc = async () => (await ok("desktop", "state", {})).doc;

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  await ok("desktop", "reset", {});
});
test.after(() => { killAllSessions(sandbox.id); _resetKernels(); closeDb(); });

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});
const answers = (port) => new Promise((res) => {
  const s = net.connect({ port, host: "127.0.0.1" });
  s.on("connect", () => { s.destroy(); res(true); });
  s.on("error", () => res(false));
  setTimeout(() => { s.destroy(); res(false); }, 1500);
});
const until = async (fn, ms = 20_000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

// ── an undo you can aim ─────────────────────────────────────────────────────

test("an undo can take back one part of the document and leave the rest", async () => {
  await ok("desktop", "open", { app: "files" });
  await ok("desktop", "open", { app: "terminal" });
  const before = await doc();
  const geometry = (d) => d.windows.map((w) => `${w.id}:${w.x},${w.y}`).join("|");
  const wasThere = geometry(before);

  // An agent's change, as two revisions: it moves things, then adds one.
  await ok("desktop", "arrange", { preset: "grid", viewport: { w: 1400, h: 900 } });
  const arranged = await doc();
  assert.notEqual(geometry(arranged), wasThere, "the alignment moved the windows");
  await ok("desktop", "widgetAdd", { kind: "clock" });
  const after = await doc();
  assert.equal(after.widgets.length, before.widgets.length + 1);

  // The whole-document undo is still what it was: it takes the widget too.
  const { revisions } = await ok("desktop", "history", {});
  const alignment = revisions.find((r) => /arrange/i.test(r.label ?? ""));
  assert.ok(alignment, "the history says which revision was the alignment");

  // Aimed at the windows, it takes back the alignment and nothing else.
  const r = await ok("desktop", "revert", { rev: alignment.rev, only: ["windows"] });
  assert.deepEqual(r.only, ["windows"]);
  const undone = await doc();
  assert.equal(geometry(undone), wasThere, "the windows are where they were");
  assert.equal(undone.widgets.length, before.widgets.length + 1, "and the widget added afterwards survived");
  assert.ok(undone.rev > after.rev, "the undo is itself a revision, so it can be undone");
});

test("a scoped undo cannot be aimed at something that is not a part", async () => {
  const { revisions } = await ok("desktop", "history", {});
  const bad = await call("desktop", "revert", { rev: revisions[0].rev, only: ["rev"] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /cannot revert 'rev'/);
  const scopes = (await ok("desktop", "revertScopes", {})).scopes;
  assert.deepEqual(scopes, [...REVERT_SCOPES]);
  assert.ok(scopes.includes("windows") && scopes.includes("theme") && scopes.includes("apps"));
  assert.equal(scopes.includes("rev"), false, "the counter is not a part of the desktop you can undo");
});

test("a scoped undo restores stacking that still makes sense", async () => {
  const before = await doc();
  const { revisions } = await ok("desktop", "history", {});
  await ok("desktop", "open", { app: "metrics" });
  const grew = await doc();
  assert.ok(grew.zTop > before.zTop);
  await ok("desktop", "revert", { rev: revisions[0].rev, only: ["windows"] });
  const back = await doc();
  // Restoring old geometry with a stale counter would put the next window
  // underneath one already on screen.
  assert.ok(back.zTop >= grew.zTop, "the stacking counter does not go backwards");
});

// ── ending a shell ends what the shell started ──────────────────────────────

test("ending a session takes the process it started with it", async (t) => {
  const port = await freePort();
  let seen = "";
  const s = attachSession(kernel.cell, sandbox.id, { name: "tree" }, (d) => { seen += d.toString(); }, () => {});
  // A grandchild of ours: the session's shell starts node, node holds the port.
  await ok("fs", "write", {
    path: "holder.js",
    content: `require('node:net').createServer(() => {}).listen(${port}, '127.0.0.1');\n`,
  });
  s.write("node holder.js &\n");
  const held = await until(() => answers(port));
  if (!held) {
    // A host with no usable shell says so rather than passing quietly.
    t.skip(`no shell could start the holder on this host (saw: ${JSON.stringify(seen.slice(-120))})`);
    killSession(sandbox.id, s.id);
    return;
  }

  killSession(sandbox.id, s.id);
  const freed = await until(async () => !(await answers(port)));
  assert.ok(freed, "the port the shell's child was holding is free again");
});

// ── and the person gets the same aim the agent has ──────────────────────────

test("the History panel offers the aim, not only the rewind", () => {
  const builder = readSource(new URL("../apps/gateway/public/js/os/builder.js", import.meta.url));
  const revert = builder.split("async function revertTo(")[1].split("async function showDiff(")[0];
  assert.match(revert, /\[got\.only\] : null/, "the dialog's choice becomes revert's only:[…]");
  assert.match(revert, /call\("revert", \{ rev: rev\.rev, \.\.\.\(only \? \{ only \} : \{\}\) \}\)/, "and an unaimed undo still sends no scope at all");
  assert.match(revert, /everything in this revision/, "and 'everything' is still the default");
  assert.match(builder, /const PART_LABELS = \{/, "the parts are named in words, not in field names");
  // Only the parts that actually changed are offered: a revision that never
  // touched the theme should not invite you to undo the theme.
  assert.match(builder, /function changedParts\(diff\)/);
});
