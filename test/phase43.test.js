// Phase 43: the links Track 1 asked for.
//
// Each app in Track 1 was built and each one worked, but several of the small
// clauses in goal.md §5 were about *getting from one to the next* — a job's
// notification deep-linking back to the job, a port shared into Access, an agent
// re-run with edits, a Tide badge that opens Sync. A machine where every answer
// is in a different window you have to know about is a machine that makes you do
// the work twice.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { notifyJobEnded, notifyAgentEnded } from "../packages/os/src/notify.js";
import { loadOs } from "../packages/os/src/store.js";

let kernel, owner, sandbox, held;
const ok = async (server, tool, args = {}) => {
  const r = await kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
  assert.ok(r.ok, `${server}.${tool}: ${r.error}`);
  return r.result;
};
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  await ok("desktop", "reset", {});
});
test.after(() => { _resetKernels(); closeDb(); });

// ── T1.1 · a notification knows what it is about ───────────────────────────

test("a job's notification carries the way back to that job", async () => {
  notifyJobEnded(sandbox, { id: "job_42", name: "build", state: "failed", code: 1 });
  const n = loadOs(sandbox).notifications.at(-1);
  assert.equal(n.title, "build failed");
  assert.deepEqual(n.action, { app: "jobs", window: null, props: { job: "job_42", follow: true } },
    "clicking it opens Jobs on that job, following its log");
  assert.equal(n.kind, "err", "and it reads as a failure");

  notifyJobEnded(sandbox, { id: "job_43", name: "test", state: "exited", code: 0 });
  const good = loadOs(sandbox).notifications.at(-1);
  assert.equal(good.kind, "ok");
  assert.equal(good.action.props.job, "job_43");
});

test("an agent's notification carries the way back to its transcript", async () => {
  notifyAgentEnded(sandbox, { id: "agt_7", name: "refactor", result: "done" }, "done");
  const n = loadOs(sandbox).notifications.at(-1);
  assert.equal(n.action.app, "agents");
  assert.equal(n.action.props.agent, "agt_7");
});

test("the shell follows a notification's action", () => {
  const shell = read("../apps/gateway/public/js/os/shell.js");
  assert.match(shell, /if \(n\.action\?\.app\) return launch\(n\.action\.app, n\.action\.props\)/,
    "a notification with an app opens it, with the props it carried");
  // And the props each app reads are the props the notification sends.
  const ops = read("../apps/gateway/public/js/os/ops.js");
  assert.match(ops, /let selected = win\.props\?\.job \?\? null;/);
  assert.match(ops, /let selected = win\.props\?\.agent \?\? null;/);
});

// ── T1.1 · and where to look for what a job opened ─────────────────────────

test("a job's pane shows the ports that are answering, without claiming they are its", () => {
  const ops = read("../apps/gateway/public/js/os/ops.js");
  assert.match(ops, /openPorts = \(p\?\.ports \?\? \[\]\)\.filter\(\(x\) => x\.up\)/, "read from ports.list, filtered to what answers");
  assert.match(ops, /answering now:/, "labelled as what it is");
  assert.match(ops, /supervised process does not tell the machine which ports it bound/,
    "and the comment says why it is not attributed to the job");
  assert.match(ops, /ctx\.launch\?\.\("browser", \{ port: Number\(p\.port\), path: "\/" \}\)/, "clicking one opens it");
});

// ── T1.2 · sharing a port is sharing the machine, narrowly ─────────────────

test("sharing a port goes through access.share, not through a link", () => {
  const ops = read("../apps/gateway/public/js/os/ops.js");
  const fn = ops.split("async function shareDialog(port)")[1].split("function paint()")[0];
  assert.match(fn, /api\.mcp\("access", "share"/, "it is a grant");
  assert.match(fn, /behind this machine's own sign-in/, "and it says why a URL is not enough");
  assert.match(fn, /ctx\.launch\?\.\("access"\)/, "then it puts you where you can revoke it");
  assert.match(ops, /Share it with someone…/);
});

test("the narrow grant it offers really is narrow", async () => {
  const { createTenant, createAccount, grantsFor: grantsOf } = await import("../packages/control-db/src/registry.js");
  const t = createTenant("phase43-tenant");
  const guest = createAccount(t.id, { username: "phase43-guest", password: "pw" });
  // Exactly what the dialog's default sends.
  await ok("access", "share", { username: "phase43-guest", patterns: ["ports.list"] });
  const theirs = grantsOf(guest.principalId, sandbox.id);
  assert.deepEqual(theirs, ["ports.list"]);
  const denied = await kernel.call({ principalId: guest.principalId, heldPatterns: theirs, server: "ports", tool: "expose", args: { port: 8080 } });
  assert.equal(denied.ok, false, "they can see what is exposed and expose nothing");
  assert.equal(denied.code, "denied");
});

// ── T1.3 · run it again, with edits ────────────────────────────────────────

test("an agent can be re-run from what it was", () => {
  const ops = read("../apps/gateway/public/js/os/ops.js");
  assert.match(ops, /async function spawnDialog\(from = null\)/, "the dialog takes a previous agent");
  const fn = ops.split("async function spawnDialog(from = null)")[1].split("function paint()")[0];
  assert.match(fn, /from\.cmd \?\? from\.prompt \?\? ""/, "and fills in what it ran");
  assert.match(fn, /\(from\.patterns \?\? from\.capabilities \?\? \[\]\)\.join\(", "\)/, "and what it held");
  assert.match(fn, /The original stays in the list with its own transcript/, "without replacing the original");
  assert.match(ops, /Run again with edits…/);
});

// ── T1.4 · a badge that goes where the change is ───────────────────────────

test("a Tide badge in Files opens Sync on that workspace", () => {
  const builtins = read("../apps/gateway/public/js/os/builtins.js");
  assert.match(builtins, /h\("button\.tide-badge"/, "the badge is a button, so a keyboard reaches it");
  assert.match(builtins, /ctx\.launch\?\.\("sync", \{ workspace: tideWorkspace \}\)/, "and it opens Sync where the change lives");
  assert.match(builtins, /ev\.stopPropagation\(\)/, "without also opening the file underneath it");
  assert.match(builtins, /tideWorkspace = name \?\? null;/, "the workspace it points at is the one the badges came from");
  const css = read("../apps/gateway/public/os.css");
  assert.match(css, /\.tide-badge:hover, \.tide-badge:focus-visible/, "and it looks like something you can press");
});

// ── T1.9 · a spike leads to the rows that caused it ────────────────────────

test("Observability rows open the audit log on that tool", () => {
  const builtins = read("../apps/gateway/public/js/os/builtins.js");
  assert.match(builtins, /onclick: \(\) => openAudit\(\{ server: t\.server, tool: t\.tool \}\)/, "a per-tool row");
  assert.match(builtins, /onclick: \(\) => openAudit\(\{ server: e\.server, tool: e\.tool \}\)/, "and a slowest-call row");
});
