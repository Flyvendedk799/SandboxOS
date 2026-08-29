// Phase 25: Tide as a surface, and a first run worth having.
//
// The tide server has been callable since Phase 2 and visible nowhere. These
// tests pin the flow the Sync workspace drives — init, status, mark, log, diff,
// restore — and the rule that first-run content must never touch a volume that
// already has something in it.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor, createTenant, createSandboxForTenant, createAccount } from "../packages/control-db/src/registry.js";
import { getKernel, _resetKernels } from "../packages/kernel/src/kernel.js";
import { seedVolume, WELCOME } from "../packages/cell/src/seed.js";

let kernel, owner, sandbox, held;
const call = (srv, tool, args = {}) =>
  kernel.call({ principalId: owner.id, heldPatterns: held, server: srv, tool, args });
const ok = async (srv, tool, args) => {
  const r = await call(srv, tool, args);
  assert.ok(r.ok, `${srv}.${tool}: ${r.error}`);
  return r.result;
};

test.before(async () => {
  openDb();
  ({ owner, sandbox } = ensureSeed("local"));
  held = grantsFor(owner.id, sandbox.id);
  kernel = await getKernel(sandbox);
});
test.after(() => { _resetKernels(); closeDb(); });

// ── The Tide flow the Sync panel drives ──────────────────────────────────────

test("a workspace maps a path inside the Sandbox", async () => {
  const r = await ok("tide", "init", { workspace: "notes", path: "notes" });
  assert.equal(r.workspace, "notes");
  assert.equal(r.head, null, "a fresh workspace has no marks");
  assert.equal(r.path, "notes", "paths come back Sandbox-relative, not as host paths");

  const { workspaces } = await ok("tide", "listWorkspaces", {});
  const ws = workspaces.find((w) => w.name === "notes");
  assert.ok(ws);
  assert.equal(ws.path, "notes");
  assert.ok(!ws.path.startsWith("/"), "the host filesystem layout must not leak to callers");
});

test("status reports the working tree against the last mark", async () => {
  await ok("fs", "write", { path: "notes/one.md", content: "first\n" });
  const { changes } = await ok("tide", "status", { workspace: "notes" });
  assert.deepEqual(changes, [{ path: "one.md", status: "added" }]);
});

test("marking snapshots the tree and leaves it clean", async () => {
  const marked = await ok("tide", "mark", { workspace: "notes", message: "first note" });
  assert.ok(marked.commit, "a change produces a mark");
  assert.equal(marked.head, marked.commit);

  const { changes } = await ok("tide", "status", { workspace: "notes" });
  assert.deepEqual(changes, [], "the working tree matches its mark");
});

test("marking an unchanged workspace writes nothing", async () => {
  const again = await ok("tide", "mark", { workspace: "notes", message: "nothing to see" });
  assert.equal(again.commit, null);
  assert.equal(again.changed, false);
});

test("the log is history, newest first, with parents", async () => {
  await ok("fs", "write", { path: "notes/two.md", content: "second\n" });
  await ok("fs", "write", { path: "notes/one.md", content: "first, edited\n" });
  await ok("tide", "mark", { workspace: "notes", message: "second note" });

  const { marks } = await ok("tide", "log", { workspace: "notes" });
  assert.equal(marks.length, 2);
  assert.equal(marks[0].message, "second note");
  assert.equal(marks[1].message, "first note");
  assert.deepEqual(marks[0].parents, [marks[1].hash]);
  assert.equal(marks[0].author, owner.id, "the marking principal is recorded");
});

test("a mark diffs against its parent — added and modified are distinguished", async () => {
  const { marks } = await ok("tide", "log", { workspace: "notes" });
  const [latest, first] = marks;
  const { changes } = await ok("tide", "diff", { workspace: "notes", from: first.hash, to: latest.hash });
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]));
  assert.equal(byPath["two.md"], "added");
  assert.equal(byPath["one.md"], "modified");
});

test("diff with no refs compares the head to the working tree", async () => {
  // This is the shape the Sync panel's "working tree" card depends on: what has
  // changed since the last mark, without naming either side.
  await ok("fs", "write", { path: "notes/three.md", content: "third\n" });
  const { changes } = await ok("tide", "diff", { workspace: "notes" });
  assert.deepEqual(changes, [{ path: "three.md", status: "added" }]);

  const status = await ok("tide", "status", { workspace: "notes" });
  assert.deepEqual(status.changes, changes, "status and a bare diff agree");

  await ok("fs", "remove", { path: "notes/three.md" });
});

test("restoring a mark rewrites the working tree inside the Cell", async () => {
  const { marks } = await ok("tide", "log", { workspace: "notes" });
  const first = marks.at(-1);
  await ok("tide", "checkout", { workspace: "notes", ref: first.hash });

  const { content } = await ok("fs", "read", { path: "notes/one.md" });
  assert.equal(content, "first\n", "the file reverted");
  const listed = await ok("fs", "list", { path: "notes" });
  assert.deepEqual(listed.entries.map((e) => e.name), ["one.md"], "two.md is gone again");

  const { head } = await ok("tide", "refs", { workspace: "notes" });
  assert.equal(head, first.hash);
});

test("every Tide action is audited like any other Kernel call", async () => {
  const { events } = await ok("kernel", "auditQuery", { limit: 200 });
  const tideCalls = events.filter((e) => e.server === "tide").map((e) => e.tool);
  for (const tool of ["init", "status", "mark", "log", "diff", "checkout"]) {
    assert.ok(tideCalls.includes(tool), `tide.${tool} must appear in the audit log`);
  }
});

test("Tide state objects carry non-file machine state", async () => {
  await ok("tide", "putState", { workspace: "notes", type: "env", data: { EDITOR: "vim" } });
  const got = await ok("tide", "getState", { workspace: "notes", type: "env" });
  assert.deepEqual(got.data, { EDITOR: "vim" });
  const { types } = await ok("tide", "listStates", { workspace: "notes" });
  assert.ok(types.includes("env"));
});

// ── First run ────────────────────────────────────────────────────────────────

test("a brand-new Sandbox is seeded with an orientation file", async () => {
  const tenant = createTenant("seed-co");
  const account = createAccount(tenant.id, { username: "seeded", password: "seed-password" });
  const sb = createSandboxForTenant(tenant.id, account.principalId, {
    slug: "seeded", name: "Seeded", cellBackend: "local",
  });

  assert.equal(seedVolume(sb), true);
  const welcome = fs.readFileSync(path.join(sb.volume_path, "WELCOME.md"), "utf8");
  assert.equal(welcome, WELCOME);
  // The content has to actually teach the machine, not just say hello.
  for (const topic of ["proc.start", "port expose", "Assistant", "⌘K"]) {
    assert.ok(welcome.includes(topic), `the welcome should mention ${topic}`);
  }
});

test("seeding never touches a volume that already has something in it", async () => {
  const tenant = createTenant("used-co");
  const account = createAccount(tenant.id, { username: "used", password: "used-password" });
  const sb = createSandboxForTenant(tenant.id, account.principalId, {
    slug: "used", name: "Used", cellBackend: "local",
  });
  fs.mkdirSync(sb.volume_path, { recursive: true });
  fs.writeFileSync(path.join(sb.volume_path, "mine.txt"), "do not clobber me");

  assert.equal(seedVolume(sb), false, "a non-empty volume is left alone");
  assert.ok(!fs.existsSync(path.join(sb.volume_path, "WELCOME.md")));
  assert.equal(fs.readFileSync(path.join(sb.volume_path, "mine.txt"), "utf8"), "do not clobber me");
});

test("seeding is idempotent and safe to call on every boot", async () => {
  const tenant = createTenant("boot-co");
  const account = createAccount(tenant.id, { username: "booted", password: "boot-password" });
  const sb = createSandboxForTenant(tenant.id, account.principalId, {
    slug: "booted", name: "Booted", cellBackend: "local",
  });
  assert.equal(seedVolume(sb), true);
  fs.writeFileSync(path.join(sb.volume_path, "WELCOME.md"), "edited by the owner");
  assert.equal(seedVolume(sb), false, "a second boot must not overwrite an edited file");
  assert.equal(fs.readFileSync(path.join(sb.volume_path, "WELCOME.md"), "utf8"), "edited by the owner");
});

test("seeding a Sandbox with no volume path is a no-op, not a crash", () => {
  assert.equal(seedVolume({}), false);
  assert.equal(seedVolume(null), false);
});
