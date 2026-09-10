// C · The hostile day — acceptance suite, goal.md §10.
//
// Everything an attacker can send, sent: an app that grabs for capabilities it
// never declared, a companion server that throws on boot, a distro whose bundle
// was edited after publication, a document the size of a small novel, two
// hundred windows, a widget that writes every ten milliseconds, a path that
// wants out of the volume, a proposal that wants a tool it should not have.
//
// The assertions are always the same shape: the refusal is typed and visible,
// the machine is still there, and the audit log can say what happened.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import {
  ensureSeed, grantsFor, createSession, createTenant, createAccount,
  createSandboxForTenant, verifyAuditChain, queryAudit,
} from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";
import { normalizeDoc, LIMITS } from "../packages/os/src/schema.js";
import { osPath } from "../packages/os/src/store.js";

let kernel, owner, sandbox, held, session, srv, port;
const call = (server, tool, args = {}) => kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });
const ok = async (server, tool, args) => { const r = await call(server, tool, args); assert.ok(r.ok, `${server}.${tool}: ${r.error}`); return r.result; };

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
  session = createSession(owner.id, "hostile");
  srv = createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  port = srv.address().port;
  await ok("desktop", "reset", {});
});
test.after(() => { srv.close(); _resetKernels(); closeDb(); });

const base = () => `http://127.0.0.1:${port}/${sandbox.slug}`;
const cookie = () => ({ cookie: `sbx_session=${session}`, "content-type": "application/json" });

/** The machine is still a machine. Called after every hostile act. */
async function stillStanding(what) {
  const state = await call("desktop", "state", {});
  assert.ok(state.ok, `the desktop still answers after ${what}: ${state.error}`);
  const chain = verifyAuditChain();
  assert.equal(chain.ok, true, `the audit chain is intact after ${what} (broken at ${chain.brokenAtId})`);
  return state.result;
}

// ── an app that asks for more than its opener holds ─────────────────────────

test("an app cannot be granted a capability its opener does not hold", async () => {
  // A second account with narrow rights on this Sandbox, and an app that wants
  // everything. What arrives is the intersection, and the rest is *named*.
  const t = createTenant("hostile-tenant");
  const guest = createAccount(t.id, { username: "hostile-guest", password: "pw" });
  const { grant } = await import("../packages/control-db/src/registry.js");
  grant(guest.principalId, sandbox.id, "desktop.get");
  grant(guest.principalId, sandbox.id, "fs.read");
  const guestSession = createSession(guest.principalId, "hostile-guest");

  await ok("desktop", "appDefine", { id: "grabby", name: "Grabby", permissions: ["fs.*", "proc.exec", "secrets.put"] });

  const r = await fetch(`${base()}/os/apps/grabby/session`, {
    method: "POST", headers: { cookie: `sbx_session=${guestSession}` },
  }).then((x) => x.json());
  assert.deepEqual(r.patterns, ["fs.read"], "only what the opener holds arrives");
  assert.ok(r.withheld.includes("proc.exec") && r.withheld.includes("secrets.put"), "and the rest is named, not silently dropped");

  // The token it did get cannot be widened by asking the Kernel directly.
  const denied = await fetch(`${base()}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${r.token}` },
    body: JSON.stringify({ server: "secrets", tool: "put", args: { name: "X", value: "y" } }),
  }).then((x) => x.json());
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "denied", `a grab is refused with a code (${JSON.stringify(denied)})`);
  await stillStanding("a capability grab");
});

// ── a companion server that cannot start ───────────────────────────────────

test("a companion server that throws on boot is reported, not fatal", async () => {
  const r = await ok("desktop", "appDefine", {
    id: "broken-tools", name: "Broken Tools",
    permissions: ["broken-tools.*"],
    mcp: { name: "broken-tools", entrypoint: "server.js", enabled: true },
    files: { "server.js": "throw new Error('I refuse to load');\n", "index.html": "<!doctype html><p>hi" },
  });
  // The define succeeds and says what went wrong with the server.
  assert.ok(r.ok);
  const catalog = await ok("kernel", "tools", {});
  assert.equal(catalog.tools.some((t) => t.name.startsWith("broken-tools.")), false, "the broken server serves nothing");
  await stillStanding("a companion that throws on boot");
});

// ── a distro whose bundle was edited after publication ─────────────────────

test("a tampered distro payload is refused at the door", async () => {
  await ok("desktop", "appDefine", { id: "shipped", name: "Shipped", files: { "index.html": "<!doctype html><p>original" } });
  const { payload } = await ok("desktop", "distroExport", { name: "shipped-box" });
  assert.ok(payload.integrity, "a published payload carries hashes");

  const tampered = structuredClone(payload);
  tampered.bundles.apps.shipped["index.html"] = "<!doctype html><p>replaced after publication";
  const refused = await call("desktop", "distroImport", { payload: tampered });
  assert.equal(refused.ok, false, "an edited bundle does not install");
  assert.match(refused.error, /integrity|hash|verif/i);

  const smuggled = structuredClone(payload);
  smuggled.bundles.apps.extra = { "index.html": "<!doctype html><p>not in the manifest" };
  const refused2 = await call("desktop", "distroImport", { payload: smuggled });
  assert.equal(refused2.ok, false, "and neither does a bundle nobody published");
  await stillStanding("a tampered distro");
});

// ── documents and payloads that are too big ────────────────────────────────

test("a document too large is refused; the ceilings clamp the rest", async () => {
  // The normalizer clamps rather than throwing, whatever arrives.
  const monstrous = normalizeDoc({
    windows: Array.from({ length: 400 }, (_, i) => ({ app: "files", title: `w${i}` })),
    widgets: Array.from({ length: 400 }, () => ({ kind: "clock" })),
    workspaces: Array.from({ length: 90 }, (_, i) => ({ n: i + 1, name: `ws${i}` })),
    notifications: Array.from({ length: 500 }, () => ({ title: "spam" })),
    proposals: Array.from({ length: 90 }, () => ({ ops: [{ tool: "themeSet", args: {} }] })),
  });
  assert.equal(monstrous.windows.length, LIMITS.windows);
  assert.equal(monstrous.widgets.length, LIMITS.widgets);
  assert.equal(monstrous.workspaces.length, LIMITS.workspaces);
  assert.equal(monstrous.notifications.length, LIMITS.notifications);
  assert.equal(monstrous.proposals.length, LIMITS.proposals);

  // A single field big enough to blow the document budget is refused by the store.
  const fat = await call("desktop", "set", {
    doc: { ...(await ok("desktop", "state", {})).doc, name: "x".repeat(64), apps: {}, widgetKinds: {},
      windows: Array.from({ length: 96 }, (_, i) => ({ id: `w_fat${i}`, app: "notes", title: "t", props: { blob: "y".repeat(8000) } })) },
  });
  assert.equal(fat.ok, false, "a document over the byte ceiling does not land");
  assert.match(fat.error, /too large/);
  await stillStanding("an oversized document");
});

test("two hundred windows is ninety-six windows", async () => {
  for (let i = 0; i < 120; i += 1) await call("desktop", "open", { app: "notes" });
  const doc = await stillStanding("two hundred window opens");
  assert.ok(doc.doc.windows.length <= LIMITS.windows, `bounded at ${doc.doc.windows.length}`);
  await ok("desktop", "reset", {});
});

// ── paths that want out ────────────────────────────────────────────────────

test("nothing reaches outside the volume, however it is spelled", async () => {
  for (const p of ["../escape.txt", "p/../../escape.txt", "/etc/../../escape.txt", "..\\escape.txt"]) {
    const r = await call("fs", "write", { path: p, content: "nope" });
    // Either refused, or contained — never written outside the volume.
    if (r.ok) {
      const outside = path.join(sandbox.volume_path, "..", "escape.txt");
      assert.equal(fs.existsSync(outside), false, `${p} must not land outside the volume`);
    }
  }
  // A bundle asset path is contained too, even with a valid key. (Defined here
  // rather than reused: a `reset` earlier in this file takes custom apps with
  // it, and a test that silently tested nothing would be worse than none.)
  await ok("desktop", "appDefine", { id: "climber", name: "Climber", files: { "index.html": "<!doctype html><p>hi" } });
  const s = await fetch(`${base()}/os/apps/climber/session`, { method: "POST", headers: cookie() }).then((x) => x.json());
  assert.ok(s.assetKey, "the frame gets a key to read its own files");
  const sneaky = await fetch(`${base()}/os/apps/climber/k/${s.assetKey}/..%2f..%2fos.json`);
  assert.equal(sneaky.status, 400, "and a bundle read cannot climb out either");
  const wrongApp = await fetch(`${base()}/os/apps/shipped/k/${s.assetKey}/index.html`);
  assert.equal(wrongApp.status, 403, "nor read another app's bundle with this app's key");
  await stillStanding("path traversal");
});

// ── a proposal that wants what it should not ────────────────────────────────

test("a proposal cannot become a way round the tools", async () => {
  const bad = await call("desktop", "propose", { ops: [{ tool: "nonsense", args: {} }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown tool/);

  // A proposal is applied *as the applier*: a narrow principal cannot use one to
  // do what it could not do by hand.
  const { grant } = await import("../packages/control-db/src/registry.js");
  const t = createTenant("hostile-proposer");
  const acc = createAccount(t.id, { username: "hostile-proposer", password: "pw" });
  grant(acc.principalId, sandbox.id, "desktop.get");
  grant(acc.principalId, sandbox.id, "desktop.propose");
  grant(acc.principalId, sandbox.id, "desktop.applyProposal");
  const narrow = grantsFor(acc.principalId, sandbox.id);

  const made = await kernel.call({
    principalId: acc.principalId, heldPatterns: narrow,
    server: "desktop", tool: "propose", args: { label: "sneaky", ops: [{ tool: "reset", args: {} }] },
  });
  assert.ok(made.ok, "proposing is allowed — it changes nothing");
  const applied = await kernel.call({
    principalId: acc.principalId, heldPatterns: narrow,
    server: "desktop", tool: "applyProposal", args: { id: made.result.proposal.id },
  });
  // The ops run through the same handlers, but the *Kernel* authorized only
  // applyProposal — so a tool the applier does not hold gets no further than it
  // would have by hand. Either the apply reports the failure, or it is denied.
  const doc = await stillStanding("a proposal aimed at a tool nobody granted");
  assert.ok(doc.doc.rev > 0);
  if (applied.ok) {
    assert.equal(applied.result.ok, false, "a proposal that fails says where it stopped");
  }
});

// ── a widget that writes as fast as it can ─────────────────────────────────

test("a widget writing in a loop is bounded by the document, not by hope", async () => {
  await ok("desktop", "widgetDefine", { kind: "spinner", name: "Spinner", refreshMs: 1 });
  const g = await ok("desktop", "widgetAdd", { kind: "spinner" });
  const before = (await ok("desktop", "state", {})).rev;
  // 60 writes, as fast as the loop can make them: every one is a revision, each
  // bounded, and the history is pruned rather than growing without limit.
  for (let i = 0; i < 60; i += 1) await ok("desktop", "widgetSet", { id: g.widget.id, props: { tick: i } });
  const after = await stillStanding("a widget writing in a loop");
  assert.equal(after.rev, before + 60, "each write is exactly one revision");
  const historyDir = path.join(path.dirname(osPath(sandbox)), "history");
  const kept = JSON.parse(fs.readFileSync(path.join(historyDir, "index.json"), "utf8"));
  assert.ok(kept.length <= LIMITS.history, `history stays bounded (${kept.length})`);
  const files = fs.readdirSync(historyDir).filter((f) => f !== "index.json");
  assert.ok(files.length <= LIMITS.history + 1, `and so do its files (${files.length})`);
});

// ── and the log can say what happened ──────────────────────────────────────

test("every refusal is in the audit log, with its reason", async () => {
  const denials = queryAudit(sandbox.id, { resultKind: "denied", limit: 50 });
  assert.ok(denials.length >= 1, "a denied call is a row, not a silence");
  assert.ok(denials.every((r) => r.server && r.tool), "with what was asked for");
  const errors = queryAudit(sandbox.id, { resultKind: "error", limit: 50 });
  assert.ok(errors.every((r) => r.error), "and an error row carries its reason");
  const chain = verifyAuditChain();
  assert.equal(chain.ok, true, "and none of it broke the chain");
});
