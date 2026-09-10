// Phase 33: authorship and control.
//
// Track 2 and Track 3 of goal.md. A change you can read before it happens, an
// app whose errors reach the person who can fix them, and a capability ledger
// that answers "what can this app do, and what has it done" from the window it
// is doing it in.
import { readSource } from "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { normalizeDoc, LIMITS } from "../packages/os/src/schema.js";
import { READ_ONLY_DESKTOP_TOOLS } from "../packages/os/src/catalog.js";
import { systemPrompt } from "../packages/assistant/src/assistant.js";

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

// ── T2.3 · a change you read before it happens ──────────────────────────────

test("a proposal is a document object, not client-side theatre", async () => {
  const r = await ok("propose", {
    label: "warm it up",
    ops: [{ tool: "themeSet", args: { theme: "aurora" } }, { tool: "widgetAdd", args: { kind: "clock" } }],
  });
  assert.equal(r.proposal.ops.length, 2);
  assert.equal(r.proposal.by, owner.id, "it records who asked");

  // It is in the document, so a second tab, a reload and a revert all see it.
  const doc = (await ok("state", {})).doc;
  assert.equal(doc.proposals.length, 1);
  assert.equal(doc.proposals[0].id, r.proposal.id);
  assert.equal(doc.theme.base, "midnight", "and nothing has happened yet");
  assert.equal(doc.widgets.length, 2, "…including the widget it proposes");
});

test("applying a proposal runs its ops as the caller, in order, and drops it", async () => {
  const { proposals } = await ok("proposals", {});
  const p = proposals.at(-1);
  const before = (await ok("state", {})).doc.widgets.length;
  const r = await ok("applyProposal", { id: p.id });
  assert.deepEqual(r.applied, ["themeSet", "widgetAdd"]);
  const doc = (await ok("state", {})).doc;
  assert.equal(doc.theme.base, "aurora", "the change landed");
  assert.equal(doc.widgets.length, before + 1);
  assert.equal(doc.proposals.length, 0, "and the proposal is gone");
  await ok("themeSet", { theme: "midnight" });
});

test("a proposal cannot smuggle in a tool that does not exist, or one that reads", async () => {
  for (const [ops, expected] of [
    [[{ tool: "nonsense", args: {} }], /unknown tool in proposal/],
    [[{ tool: "state", args: {} }], /changes nothing/],
    [[], /at least one op/],
  ]) {
    const r = await call("propose", { ops });
    assert.equal(r.ok, false, JSON.stringify(ops));
    assert.match(r.error, expected);
  }
});

test("a proposal applies only what it can, and says where it stopped", async () => {
  const { proposal } = await ok("propose", {
    label: "half of it",
    ops: [
      { tool: "themeSet", args: { theme: "tide" } },
      { tool: "close", args: { id: "w_does_not_exist" } },
      { tool: "themeSet", args: { theme: "sunset" } },
    ],
  });
  const r = await ok("applyProposal", { id: proposal.id });
  assert.deepEqual(r.applied, ["themeSet"]);
  assert.equal(r.ok, false);
  assert.match(r.failure.tool, /close/);
  const doc = (await ok("state", {})).doc;
  assert.equal(doc.theme.base, "tide", "what ran, ran");
  assert.equal(doc.proposals.length, 0, "and the proposal does not linger half-applied");
  await ok("themeSet", { theme: "midnight" });
});

test("discarding a proposal changes nothing but the proposal", async () => {
  const { proposal } = await ok("propose", { ops: [{ tool: "themeSet", args: { theme: "sunset" } }] });
  await ok("discardProposal", { id: proposal.id });
  const doc = (await ok("state", {})).doc;
  assert.equal(doc.proposals.length, 0);
  assert.equal(doc.theme.base, "midnight");
  const gone = await call("discardProposal", { id: proposal.id });
  assert.equal(gone.ok, false, "and it is not there twice");
});

test("proposals are normalized and bounded like everything else in the document", () => {
  const doc = normalizeDoc({
    proposals: [
      ...Array.from({ length: LIMITS.proposals + 4 }, (_, i) => ({ label: `p${i}`, ops: [{ tool: "themeSet", args: {} }] })),
      { label: "no ops at all", ops: [] },
      { label: "bad names", ops: [{ tool: "not a tool name", args: {} }] },
      { label: "too many", ops: Array.from({ length: LIMITS.proposalOps + 10 }, () => ({ tool: "themeSet", args: {} })) },
    ],
  });
  assert.ok(doc.proposals.length <= LIMITS.proposals, `bounded (${doc.proposals.length})`);
  assert.ok(doc.proposals.every((p) => p.ops.length && p.ops.length <= LIMITS.proposalOps));
  assert.ok(doc.proposals.every((p) => p.ops.every((op) => /^[a-zA-Z][a-zA-Z0-9]+$/.test(op.tool))));
});

test("review mode is announced to the model, and only when it is on", () => {
  const on = systemPrompt(sandbox, ["desktop"], ["*"], { propose: true });
  const off = systemPrompt(sandbox, ["desktop"], ["*"]);
  assert.match(on, /REVIEW MODE IS ON/);
  assert.match(on, /never claim the desktop has changed/);
  assert.doesNotMatch(off, /REVIEW MODE/);
});

test("the assistant captures desktop writes and lets desktop reads through", () => {
  // The rule lives in one place, and both the proposal tool and the assistant
  // read it: a mutation is captured, a read is not.
  for (const t of ["state", "summarize", "appRead", "proposals"]) assert.ok(READ_ONLY_DESKTOP_TOOLS.has(t), t);
  for (const t of ["themeSet", "open", "move", "appWrite", "distroFork"]) assert.ok(!READ_ONLY_DESKTOP_TOOLS.has(t), t);
  const src = readSource(new URL("../packages/assistant/src/assistant.js", import.meta.url));
  assert.match(src, /if \(propose && server === "desktop" && !READ_ONLY_DESKTOP_TOOLS\.has\(tool\)\)/);
  assert.match(src, /tool: "propose"/, "and the turn writes one proposal at the end");
});

// ── T2.2 · an app's errors reach the person who can fix them ────────────────

test("the bridge reports an app's errors out of its opaque frame", () => {
  const src = readSource(new URL("../apps/gateway/public/js/os/bridge.js", import.meta.url));
  assert.match(src, /addEventListener\("error"/, "uncaught errors");
  assert.match(src, /unhandledrejection/, "rejected promises");
  assert.match(src, /console\[level\] = /, "and what the app prints");
  assert.match(src, /type: "log"/, "as a one-way note to the shell");
  // It must not become a second channel *in*: a log carries no id, so the
  // broker never replies to it and an app cannot use it to ask for anything.
  assert.doesNotMatch(src.split('function report(')[1].split("}")[0], /\bid\b/);
});

test("the broker keeps each app's output, bounded, and hands it to the Studio", () => {
  const src = readSource(new URL("../apps/gateway/public/js/os/frames.js", import.meta.url));
  assert.match(src, /export function frameLogs/);
  assert.match(src, /export function onFrameLog/);
  assert.match(src, /while \(list\.length > LOG_KEEP\) list\.shift\(\)/, "an app in a loop is not a leak");
  const code = readSource(new URL("../apps/gateway/public/js/os/code.js", import.meta.url));
  assert.match(code, /frameLogs, clearFrameLogs, onFrameLog/, "and the Code tab shows them");
});

test("the editor can be told to go to a line, which is what a search hit needs", () => {
  const src = readSource(new URL("../apps/gateway/public/js/editor.js", import.meta.url));
  assert.match(src, /reveal\(line, \{ column = 1, length = 0 \} = \{\}\)/);
  const code = readSource(new URL("../apps/gateway/public/js/os/code.js", import.meta.url));
  assert.match(code, /async function replaceIn\(onlyPath\)/, "replace in one file or all of them");
  assert.match(code, /\.reveal\(line, \{ column, length \}\)/, "and a hit is somewhere you can go");
});

// ── the tools travel: SDK, CLI and the surface map ──────────────────────────

test("the new tools are in the catalogue, so an agent can find them", async () => {
  const { tools } = await kernel.call({ principalId: owner.id, heldPatterns: held, server: "kernel", tool: "tools", args: {} })
    .then((r) => r.result);
  const names = new Set(tools.map((t) => t.name));
  for (const n of [
    "desktop.propose", "desktop.proposals", "desktop.applyProposal", "desktop.discardProposal",
    "proc.sessions", "proc.sessionKill", "access.share", "access.mint", "kernel.auditVerify",
  ]) assert.ok(names.has(n), `${n} is missing from the catalogue`);
});

// ── the frame can read its own files ────────────────────────────────────────

test("a frame reads its own bundle through a keyed path, not a cookie", async () => {
  // The bug this pins cost a whole phase of "custom apps work": the frame runs
  // at an opaque origin, so its module fetches carry no cookie and were refused,
  // and every app's JavaScript silently never ran.
  const { createServer } = await import("../apps/gateway/src/server.js");
  const { createSession } = await import("../packages/control-db/src/registry.js");
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}/${sandbox.slug}`;
  const session = createSession(owner.id, "p33");
  try {
    await ok("appDefine", { id: "keyed", name: "Keyed", permissions: ["fs.read"] });

    const s = await fetch(`${base}/os/apps/keyed/session`, { method: "POST", headers: { cookie: `sbx_session=${session}` } }).then((r) => r.json());
    assert.ok(s.assetKey, "the session hands over an asset key");

    // With the key and no cookie at all — exactly what the frame sends.
    const asJs = await fetch(`${base}/os/apps/keyed/k/${s.assetKey}/app.js`, { headers: { origin: "null" } });
    assert.equal(asJs.status, 200, "the frame can read its own module");
    assert.equal(asJs.headers.get("access-control-allow-origin"), "*", "as a plain CORS request");

    // The entry document is rewritten so the module fetch is a CORS request at all.
    const html = await fetch(`${base}/os/apps/keyed/k/${s.assetKey}/`, { headers: { origin: "null" } }).then((r) => r.text());
    assert.match(html, /<script crossorigin="anonymous" type="module"|<script type="module" crossorigin="anonymous"/);
    assert.match(html, /bridge\.js/, "and the bridge is injected");

    // The key is not a skeleton key: wrong key, wrong app, and traversal all fail.
    assert.equal((await fetch(`${base}/os/apps/keyed/k/not-a-key/app.js`)).status, 403);
    await ok("appDefine", { id: "other", name: "Other" });
    assert.equal((await fetch(`${base}/os/apps/other/k/${s.assetKey}/app.js`)).status, 403);
    // A traversal never resolves to a file: the URL is normalized away from the
    // keyed route (and refused for want of a session), and an *encoded* one is
    // refused by the path containment check inside it.
    assert.ok([401, 403, 404].includes((await fetch(`${base}/os/apps/keyed/k/${s.assetKey}/../../../os.json`)).status));
    assert.equal((await fetch(`${base}/os/apps/keyed/k/${s.assetKey}/..%2f..%2fos.json`)).status, 400);
  } finally {
    srv.close();
  }
});

// ── T3.1 · the capability ledger ────────────────────────────────────────────

test("an app's ledger says what it may do and what it has done", async () => {
  await ok("appDefine", { id: "ledgered", name: "Ledgered", permissions: ["fs.read", "ports.list"] });
  const led = await ok("appLedger", { id: "ledgered" });
  assert.deepEqual(led.declared, ["fs.read", "ports.list"]);
  assert.deepEqual(led.granted, ["fs.read", "ports.list"], "the owner holds * so nothing is withheld");
  assert.deepEqual(led.withheld, []);
  assert.equal(led.suspended, false);
  assert.ok(Array.isArray(led.calls), "and the calls come from the audit log");
});

test("an app can be suspended, which is not the same as removing it", async () => {
  const r = await ok("appSuspend", { id: "ledgered", suspended: true });
  assert.equal(r.suspended, true);
  const led = await ok("appLedger", { id: "ledgered" });
  assert.equal(led.suspended, true);
  assert.match(led.note, /no new session/);
  // It keeps its definition and its source: this is a pause, not a delete.
  const doc = (await ok("state", {})).doc;
  assert.ok(doc.apps.ledgered, "the app is still there");
  assert.equal(doc.apps.ledgered.suspended, true, "and the document remembers");
  await ok("appSuspend", { id: "ledgered", suspended: false });
  assert.equal((await ok("appLedger", { id: "ledgered" })).suspended, false);
});

test("a suspended app gets no capability session, and says so", async () => {
  const { createServer } = await import("../apps/gateway/src/server.js");
  const { createSession } = await import("../packages/control-db/src/registry.js");
  const srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/${sandbox.slug}`;
  const session = createSession(owner.id, "p33b");
  try {
    await ok("appSuspend", { id: "ledgered", suspended: true });
    const s = await fetch(`${base}/os/apps/ledgered/session`, { method: "POST", headers: { cookie: `sbx_session=${session}` } }).then((r) => r.json());
    assert.equal(s.token, null, "no token");
    assert.equal(s.suspended, true);
    assert.deepEqual(s.patterns, [], "and nothing granted");
    assert.ok(s.assetKey, "but it can still load its own source — suspension is about capabilities");
    await ok("appSuspend", { id: "ledgered", suspended: false });
  } finally {
    srv.close();
  }
});
