// Phase 28: foundation depth and the Studio as a builder.
//
// Wave A pins the tiling tree as a document field the server can reason about
// without knowing a pixel, alias resolution, conditional commits that fail
// honestly, and a history that can say what a revision changed. Wave B pins the
// tool surface the Studio grew: batched moves, z-order, hot CSS.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, mintMachineToken } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";
import { normalizeDoc, resolveAlias } from "../packages/os/src/schema.js";
import {
  buildTree, treeBoxes, treeLeaves, reconcileTree, normalizeTree, splitFor, setRatio, swapLeaves, treeSashes, describeTree,
} from "../packages/os/src/layout.js";

let kernel, owner, sandbox, held, srv, port, token;

const call = (tool, args = {}) =>
  kernel.call({ principalId: owner.id, heldPatterns: held, server: "desktop", tool, args });
const ok = async (tool, args) => {
  const r = await call(tool, args);
  assert.ok(r.ok, `desktop.${tool}: ${r.error}`);
  return r.result;
};
const http = (p, init = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  token = mintMachineToken(owner.id, sandbox.id, ["*"], { label: "p28" }).token;
  srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
  // Start from a known desktop.
  await ok("reset", {});
  for (const w of (await ok("windowList")).windows) await ok("close", { id: w.id });
});
test.after(() => { srv.close(); _resetKernels(); closeDb(); });

// ── A1 · the tiling tree is a document field ────────────────────────────────

test("the layout module is pure arithmetic: same tree, two viewports, two answers", () => {
  const tree = buildTree(["a", "b", "c"], "master-stack", { ratio: 0.6 });
  assert.equal(describeTree(tree), "⇔60%[a | ⇕50%[b | c]]");
  const wide = treeBoxes(tree, { x: 0, y: 0, w: 1000, h: 600 }, 10);
  const tall = treeBoxes(tree, { x: 0, y: 0, w: 400, h: 900 }, 10);
  assert.equal(wide.get("a").w, 582, "the master takes 60% of the width minus gaps");
  assert.equal(tall.get("a").w, 222);
  assert.equal(wide.get("b").y, 10);
  assert.equal(wide.get("c").y, wide.get("b").y + wide.get("b").h + 10, "the stack is gapped, not overlapped");
  assert.equal(treeSashes(tree, { x: 0, y: 0, w: 1000, h: 600 }, 10).length, 2, "one sash per split");
});

test("normalizeTree never throws and never keeps a window that is gone", () => {
  assert.equal(normalizeTree({ type: "split", dir: "row", ratio: 9, a: { type: "leaf", id: "x" }, b: { type: "leaf", id: "gone" } }, ["x"]).id, "x",
    "a split with one dead side collapses to the survivor");
  assert.equal(normalizeTree({ nonsense: true }, ["x"]), null);
  assert.equal(normalizeTree("string", ["x"]), null);
  const clamped = normalizeTree({ type: "split", dir: "diagonal", ratio: 9, a: { type: "leaf", id: "x" }, b: { type: "leaf", id: "y" } }, ["x", "y"]);
  assert.equal(clamped.ratio, 0.9);
  assert.equal(clamped.dir, "row", "an unknown axis becomes a row, not a crash");
  // Depth is bounded.
  let deep = { type: "leaf", id: "l0" };
  for (let i = 1; i < 40; i += 1) deep = { type: "split", dir: "row", ratio: 0.5, a: deep, b: { type: "leaf", id: `l${i}` } };
  const ids = Array.from({ length: 40 }, (_, i) => `l${i}`);
  assert.ok(treeLeaves(normalizeTree(deep, ids)).length < 40, "a 40-deep tree is truncated rather than rendered");
});

test("reconcileTree makes the tree say exactly which windows are on the workspace", () => {
  const t = reconcileTree(null, ["a", "b"]);
  assert.deepEqual(treeLeaves(t).sort(), ["a", "b"], "a missing tree is synthesized");
  const t2 = reconcileTree(t, ["a", "b", "c"]);
  assert.deepEqual(treeLeaves(t2).sort(), ["a", "b", "c"], "a newcomer is split in");
  assert.equal(setRatio(t2, splitFor(t2, "a", "b"), 0.25).ratio ?? 0.25, 0.25);
  assert.deepEqual(treeLeaves(swapLeaves(t2, "a", "c"))[0], "c");
  const t3 = reconcileTree(t2, ["c"]);
  assert.deepEqual(t3, { type: "leaf", id: "c" }, "everything else pruned collapses to one leaf");
});

test("an old document with no tree gains one, and the tree follows the windows", () => {
  const doc = normalizeDoc({
    workspaces: [{ name: "one" }, { name: "two" }],
    windows: [{ id: "w1", app: "files", ws: 1 }, { id: "w2", app: "notes", ws: 1 }, { id: "w3", app: "media", ws: 2 }],
  });
  assert.deepEqual(treeLeaves(doc.workspaces[0].layout).sort(), ["w1", "w2"]);
  assert.deepEqual(treeLeaves(doc.workspaces[1].layout), ["w3"]);
  const again = normalizeDoc({ ...doc, windows: doc.windows.filter((w) => w.id !== "w2") });
  assert.deepEqual(again.workspaces[0].layout, { type: "leaf", id: "w1" }, "closing a window prunes it from the tree");
  const stale = normalizeDoc({ ...doc, workspaces: [{ ...doc.workspaces[0], layout: { type: "leaf", id: "ghost" } }, doc.workspaces[1]] });
  assert.deepEqual(treeLeaves(stale.workspaces[0].layout).sort(), ["w1", "w2"], "a tree naming a window that does not exist is rebuilt");
});

test("layoutSet builds a master-stack the shell will paint, and tile edits it", async () => {
  const a = (await ok("open", { app: "terminal" })).window;
  const b = (await ok("open", { app: "files" })).window;
  const c = (await ok("open", { app: "notes" })).window;
  const r = await ok("layoutSet", { mode: "tiling", preset: "master-stack", ratio: 0.7 });
  assert.equal(r.wm.mode, "tiling");
  assert.equal(r.layout.type, "split");
  assert.equal(r.layout.ratio, 0.7);
  assert.equal(r.layout.a.id, c.id, "the window in front is the master");

  const t = await ok("tile", { id: c.id, with: a.id, ratio: 0.5 });
  assert.equal(t.layout.ratio, 0.5, "the sash between master and stack moved");
  const sw = await ok("tile", { id: c.id, swap: a.id });
  assert.equal(sw.layout.a.id, a.id, "swapping leaves makes the terminal the master");
  const flipped = await ok("tile", { id: a.id, dir: "col" });
  assert.equal(flipped.layout.dir, "col");

  const bad = await call("tile", { id: "w_nope", ratio: 0.5 });
  assert.equal(bad.ok, false);

  const state = (await ok("state")).doc;
  const ws = state.workspaces.find((w) => w.n === state.activeWorkspace);
  assert.deepEqual(treeLeaves(ws.layout).sort(), [a.id, b.id, c.id].sort(), "desktop.state carries the same tree");

  // Two viewports, one tree: the shell computes pixels, the document does not hold them.
  const wide = treeBoxes(ws.layout, { x: 0, y: 0, w: 1600, h: 900 }, state.wm.gap);
  const phone = treeBoxes(ws.layout, { x: 0, y: 0, w: 390, h: 800 }, state.wm.gap);
  assert.notEqual(wide.get(a.id).w, phone.get(a.id).w);
  assert.equal(wide.size, 3);
});

test("arrange with a tree preset writes geometry when floating and the tree when tiling", async () => {
  await ok("layoutSet", { mode: "floating" });
  const r = await ok("arrange", { preset: "columns", viewport: { w: 1200, h: 800 } });
  const xs = r.windows.map((w) => w.x).sort((p, q) => p - q);
  assert.equal(new Set(xs).size, xs.length, "columns give every window its own x");
  assert.ok(r.windows.every((w) => w.w < 500), "three columns in 1200px");
  assert.ok(r.layout, "the tree is recorded too, so switching to tiling keeps the arrangement");
  await ok("layoutSet", { mode: "tiling" });
  const rows = await ok("arrange", { preset: "rows" });
  assert.equal(rows.layout.dir, "col");
});

test("revert restores the tree", async () => {
  const before = (await ok("state")).doc;
  await ok("layoutSet", { preset: "grid" });
  await ok("revert", { rev: before.rev });
  const after = (await ok("state")).doc;
  assert.deepEqual(after.workspaces[0].layout, before.workspaces[0].layout);
  await ok("layoutSet", { mode: "floating" });
});

// ── A2 · aliases ────────────────────────────────────────────────────────────

test("an alias opens its target under its own name, and rings of aliases are dropped", async () => {
  await ok("appDefine", { id: "term", name: "Term", kind: "alias", target: "terminal" });
  const r = await ok("open", { app: "term" });
  assert.equal(r.window.app, "terminal", "the window runs the target");
  assert.equal(r.window.title, "Term", "and wears the alias's name");
  await ok("close", { id: r.window.id });

  await ok("appDefine", { id: "loop-a", name: "A", kind: "alias", target: "loop-b" });
  const loop = await call("appDefine", { id: "loop-b", name: "B", kind: "alias", target: "loop-a" });
  assert.equal(loop.ok, false, "closing a ring of aliases is refused at the door");
  assert.match(loop.error, /loop/);
  const self = await call("appDefine", { id: "me", name: "Me", kind: "alias", target: "me" });
  assert.equal(self.ok, false);
  const d = (await ok("state")).doc;
  assert.equal(d.apps["loop-b"], undefined);
  const ringed = normalizeDoc({ apps: { x: { id: "x", kind: "alias", target: "y" }, y: { id: "y", kind: "alias", target: "x" }, z: { id: "z", kind: "alias", target: "files" } } });
  assert.deepEqual(Object.keys(ringed.apps), ["z"], "a document that arrives already looped loses the ring in normalizeDoc");
  await ok("appRemove", { id: "loop-a" });
  assert.equal(resolveAlias(d, "term"), "terminal");
  await ok("appRemove", { id: "term" });
});

// ── A3 · conditional commits ────────────────────────────────────────────────

test("a stale write is refused with its own code, not a generic error", async () => {
  const w = (await ok("open", { app: "files" })).window;
  const { rev } = await ok("state");
  await ok("move", { id: w.id, x: 10, y: 10 });                   // an agent moved it first
  const r = await call("move", { id: w.id, x: 500, y: 500, expectRev: rev });
  assert.equal(r.ok, false);
  assert.equal(r.code, "stale_rev", "the client can tell a lost race from a bug");
  assert.match(r.error, /stale write/);
  const now = (await ok("state")).doc.windows.find((x) => x.id === w.id);
  assert.equal(now.x, 10, "the agent's edit was not silently overwritten");
  const fine = await call("move", { id: w.id, x: 500, y: 500, expectRev: (await ok("state")).rev });
  assert.equal(fine.ok, true, "with the current revision the same write lands");
  await ok("close", { id: w.id });
});

test("the HTTP envelope carries stale_rev too", async () => {
  const r = await http(`/${sandbox.slug}/mcp`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server: "desktop", tool: "layoutSet", args: { gap: 8, expectRev: 1 } }),
  });
  const env = await r.json();
  assert.equal(env.ok, false);
  assert.equal(env.code, "stale_rev");
});

// ── A4 · history that explains itself ───────────────────────────────────────

test("history can say what a revision changed", async () => {
  const before = (await ok("state")).doc;
  await ok("themeSet", { theme: "sunset" });
  const w = (await ok("open", { app: "media" })).window;
  const r = await ok("history", { rev: before.rev });
  assert.equal(r.rev, before.rev);
  assert.ok(r.diff.theme.includes("base"), "the theme base changed");
  assert.equal(r.diff.windows.added, 1);
  assert.ok(r.revisions.length >= 2);
  const missing = await call("history", { rev: 999_999 });
  assert.equal(missing.ok, false);
  await ok("close", { id: w.id });
  await ok("themeSet", { theme: "midnight" });
});

// ── B4 · batched geometry and z-order ───────────────────────────────────────

test("move and resize take several elements in one revision", async () => {
  const a = (await ok("open", { app: "files" })).window;
  const g = (await ok("widgetAdd", { kind: "clock" })).widget;
  const before = (await ok("state")).rev;
  const r = await ok("move", { items: [{ id: a.id, x: 100, y: 100 }, { id: g.id, x: 100, y: 300 }] });
  assert.equal(r.moved, 2);
  assert.equal(r.rev, before + 1, "an alignment is one revision, not one per element");
  const d = (await ok("state")).doc;
  assert.equal(d.windows.find((w) => w.id === a.id).x, 100);
  assert.equal(d.widgets.find((x) => x.id === g.id).y, 300);
  await ok("resize", { items: [{ id: a.id, w: 333, h: 222 }, { id: g.id, w: 250 }] });
  const d2 = (await ok("state")).doc;
  assert.equal(d2.windows.find((w) => w.id === a.id).w, 333);
  assert.equal(d2.widgets.find((x) => x.id === g.id).w, 250);
  await ok("widgetRemove", { id: g.id });

  const b = (await ok("open", { app: "notes" })).window;
  await ok("windowSet", { id: b.id, back: true });
  const d3 = (await ok("state")).doc;
  const zb = d3.windows.find((w) => w.id === b.id).z;
  assert.ok(d3.windows.filter((w) => w.id !== b.id).every((w) => w.z > zb), "sent to back means behind everything");
  await ok("close", { id: a.id });
  await ok("close", { id: b.id });
});

test("a notification can point somewhere, and be dismissed alone", async () => {
  const w = (await ok("open", { app: "metrics" })).window;
  const r = await ok("notify", { title: "load is high", action: { app: "metrics", window: w.id } });
  assert.equal(r.notification.action.window, w.id);
  const other = await ok("notify", { title: "another" });
  await ok("notificationsClear", { id: r.notification.id });
  const d = (await ok("state")).doc;
  assert.ok(!d.notifications.some((n) => n.id === r.notification.id));
  assert.ok(d.notifications.some((n) => n.id === other.notification.id), "dismissing one leaves the rest");
  await ok("close", { id: w.id });
});

test("the shared layout module is served to the browser from the same file the Kernel uses", async () => {
  const r = await http("/static/js/os/lib/layout.js");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /export function treeBoxes/);
  const nope = await http("/static/js/os/lib/store.js");
  assert.equal(nope.status, 404, "only the pure modules are exposed");
});
