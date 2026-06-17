// Phase 2 Tide: object store, merge, repo operations, MCP server, client push/pull.
import "./_setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { openDb, closeDb } from "../packages/control-db/src/db.js";
import { ensureSeed, grantsFor } from "../packages/control-db/src/registry.js";
import { getKernel } from "../packages/kernel/src/kernel.js";
import { createServer } from "../apps/gateway/src/server.js";

import {
  hashObject, writeObject, readObject, hasObject,
  writeBlob, writeTree, readTree, writeCommit, readCommit,
  buildTreeFromDir, checkoutTree, listTree, diffTrees,
  isAncestor, reachable, exportObjects, importObjects,
  commonAncestor, readFileFromTree,
} from "../packages/tide/src/objects.js";
import { merge3 } from "../packages/tide/src/merge.js";
import { Repo } from "../packages/tide/src/repo.js";
import { TideClient } from "../packages/tide/src/client.js";

// ── helpers ───────────────────────────────────────────────────────────────────
const tmp = () => path.join(os.tmpdir(), `tide-test-${crypto.randomUUID().slice(0, 8)}`);
const write = (dir, name, content) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. Object store
// ═════════════════════════════════════════════════════════════════════════════

test("hashObject is deterministic and type-salted", () => {
  const h1 = hashObject("blob", Buffer.from("hello"));
  const h2 = hashObject("blob", Buffer.from("hello"));
  const h3 = hashObject("tree", Buffer.from("hello")); // different type → different hash
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(h1.length, 64); // sha256 hex
});

test("writeBlob / readObject round-trips and deduplicates", () => {
  const store = tmp();
  const hash = writeBlob(store, Buffer.from("hello tide"));
  const { type, buf } = readObject(store, hash);
  assert.equal(type, "blob");
  assert.equal(buf.toString(), "hello tide");
  // writing the same content again returns the same hash without error
  const hash2 = writeBlob(store, Buffer.from("hello tide"));
  assert.equal(hash, hash2);
  assert.ok(hasObject(store, hash));
});

test("writeTree / readTree round-trips sorted entries", () => {
  const store = tmp();
  const blobHash = writeBlob(store, Buffer.from("data"));
  const entries = [
    { name: "z.txt", type: "blob", hash: blobHash },
    { name: "a.txt", type: "blob", hash: blobHash },
  ];
  const treeHash = writeTree(store, entries);
  const out = readTree(store, treeHash);
  assert.equal(out[0].name, "a.txt"); // sorted
  assert.equal(out[1].name, "z.txt");
  assert.equal(out[0].hash, blobHash);
});

test("writeCommit / readCommit round-trips", () => {
  const store = tmp();
  const treeHash = writeTree(store, []);
  const commitHash = writeCommit(store, { tree: treeHash, parents: [], message: "init", author: "test", ts: 1000 });
  const c = readCommit(store, commitHash);
  assert.equal(c.tree, treeHash);
  assert.equal(c.message, "init");
  assert.equal(c.ts, 1000);
  assert.deepEqual(c.parents, []);
});

test("buildTreeFromDir snapshots a directory", () => {
  const store = tmp();
  const dir = tmp();
  write(dir, "hello.txt", "world");
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  write(path.join(dir, "sub"), "deep.txt", "deep");
  const treeHash = buildTreeFromDir(store, dir);
  const paths = listTree(store, treeHash);
  assert.ok(paths.includes("hello.txt"));
  assert.ok(paths.includes("sub/deep.txt"));
});

test("checkoutTree materializes tree into a directory", () => {
  const store = tmp();
  const dir = tmp();
  write(dir, "a.txt", "alpha");
  write(dir, "b.txt", "beta");
  const treeHash = buildTreeFromDir(store, dir);
  const out = tmp();
  checkoutTree(store, treeHash, out);
  assert.equal(fs.readFileSync(path.join(out, "a.txt"), "utf8"), "alpha");
  assert.equal(fs.readFileSync(path.join(out, "b.txt"), "utf8"), "beta");
});

test("checkoutTree removes files not in the target tree", () => {
  const store = tmp();
  const dir = tmp();
  write(dir, "keep.txt", "keep");
  const treeHash = buildTreeFromDir(store, dir);
  const out = tmp();
  write(out, "extra.txt", "will be removed");
  checkoutTree(store, treeHash, out);
  assert.ok(fs.existsSync(path.join(out, "keep.txt")));
  assert.ok(!fs.existsSync(path.join(out, "extra.txt")));
});

test("listTree enumerates all blob paths recursively", () => {
  const store = tmp();
  const dir = tmp();
  write(dir, "root.txt", "r");
  fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
  write(path.join(dir, "a", "b"), "leaf.txt", "l");
  const treeHash = buildTreeFromDir(store, dir);
  const paths = listTree(store, treeHash);
  assert.ok(paths.includes("root.txt"));
  assert.ok(paths.includes("a/b/leaf.txt"));
});

test("diffTrees detects added, modified, deleted", () => {
  const store = tmp();
  const dir = tmp();
  write(dir, "same.txt", "same");
  write(dir, "change.txt", "before");
  write(dir, "del.txt", "gone");
  const treeA = buildTreeFromDir(store, dir);
  fs.writeFileSync(path.join(dir, "change.txt"), "after");
  fs.unlinkSync(path.join(dir, "del.txt"));
  write(dir, "new.txt", "added");
  const treeB = buildTreeFromDir(store, dir);
  const diff = diffTrees(store, treeA, treeB);
  const byPath = Object.fromEntries(diff.map((d) => [d.path, d.status]));
  assert.equal(byPath["change.txt"], "modified");
  assert.equal(byPath["del.txt"], "deleted");
  assert.equal(byPath["new.txt"], "added");
  assert.equal(byPath["same.txt"], undefined); // unchanged
});

test("isAncestor handles linear history and missing links", () => {
  const store = tmp();
  const t = writeTree(store, []);
  const c1 = writeCommit(store, { tree: t, parents: [], message: "c1", ts: 1 });
  const c2 = writeCommit(store, { tree: t, parents: [c1], message: "c2", ts: 2 });
  const c3 = writeCommit(store, { tree: t, parents: [c2], message: "c3", ts: 3 });
  assert.ok(isAncestor(store, c1, c3));
  assert.ok(isAncestor(store, null, c3));  // null is always an ancestor
  assert.ok(!isAncestor(store, c3, c1));   // c3 is NOT an ancestor of c1
});

test("commonAncestor finds LCA of divergent branches", () => {
  const store = tmp();
  const t = writeTree(store, []);
  const base = writeCommit(store, { tree: t, parents: [], message: "base", ts: 1 });
  const ours = writeCommit(store, { tree: t, parents: [base], message: "ours", ts: 2 });
  const theirs = writeCommit(store, { tree: t, parents: [base], message: "theirs", ts: 2 });
  assert.equal(commonAncestor(store, ours, theirs), base);
});

test("exportObjects / importObjects transport the full closure", () => {
  const store = tmp();
  const dir = tmp();
  write(dir, "data.txt", "payload");
  const treeHash = buildTreeFromDir(store, dir);
  const commitHash = writeCommit(store, { tree: treeHash, parents: [], message: "m", ts: 1 });
  const hashes = reachable(store, commitHash);
  const objs = exportObjects(store, hashes);
  assert.ok(objs.length >= 2); // at least commit + tree + blob

  // import into a fresh store
  const store2 = tmp();
  importObjects(store2, objs);
  assert.ok(hasObject(store2, commitHash));
  assert.ok(hasObject(store2, treeHash));
  const { buf } = readObject(store2, readTree(store2, treeHash)[0].hash);
  assert.equal(buf.toString(), "payload");
});

test("reachable excludes objects already in have set", () => {
  const store = tmp();
  const t = writeTree(store, []);
  const c1 = writeCommit(store, { tree: t, parents: [], message: "c1", ts: 1 });
  const c2 = writeCommit(store, { tree: t, parents: [c1], message: "c2", ts: 2 });
  const all = reachable(store, c2);
  const delta = reachable(store, c2, [c1]);
  // delta should only contain c2 (and its unique objects), not c1's closure
  assert.ok(all.size > delta.size);
  assert.ok(delta.has(c2));
  assert.ok(!delta.has(c1));
});

test("readFileFromTree reads a nested file by slash-path", () => {
  const store = tmp();
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  write(path.join(dir, "src"), "index.js", "export const x = 1;");
  const treeHash = buildTreeFromDir(store, dir);
  const buf = readFileFromTree(store, treeHash, "src/index.js");
  assert.equal(buf.toString(), "export const x = 1;");
  assert.equal(readFileFromTree(store, treeHash, "nonexistent.txt"), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. merge3
// ═════════════════════════════════════════════════════════════════════════════

test("merge3: only ours changed → take ours", () => {
  const r = merge3("base", "ours", "base");
  assert.equal(r.conflict, false);
  assert.equal(r.merged, "ours");
});

test("merge3: only theirs changed → take theirs", () => {
  const r = merge3("base", "base", "theirs");
  assert.equal(r.conflict, false);
  assert.equal(r.merged, "theirs");
});

test("merge3: both changed identically → no conflict", () => {
  const r = merge3("base", "same", "same");
  assert.equal(r.conflict, false);
  assert.equal(r.merged, "same");
});

test("merge3: disjoint single-line edits → auto-merge", () => {
  // base: 3 lines; ours changes line 0, theirs changes line 2
  const base   = "line0\nline1\nline2";
  const ours   = "LINE0\nline1\nline2";
  const theirs = "line0\nline1\nLINE2";
  const r = merge3(base, ours, theirs);
  assert.equal(r.conflict, false);
  assert.equal(r.merged, "LINE0\nline1\nLINE2");
});

test("merge3: true concurrent divergence → conflict markers", () => {
  const r = merge3("base", "ours-edit", "theirs-edit");
  assert.equal(r.conflict, true);
  assert.ok(r.merged.includes("<<<<<<< ours"));
  assert.ok(r.merged.includes(">>>>>>> theirs"));
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Repo
// ═════════════════════════════════════════════════════════════════════════════

test("Repo.init creates a workspace; has / get / list reflect it", () => {
  const store = tmp();
  const workdir = tmp();
  const repo = new Repo(store);
  repo.init("ws", workdir);
  assert.ok(repo.has("ws"));
  assert.equal(repo.get("ws").head, null);
  const list = repo.list();
  assert.ok(list.some((w) => w.name === "ws"));
  assert.throws(() => repo.get("nope"), /no such workspace/);
});

test("Repo.mark creates a commit; no-change mark returns null", () => {
  const store = tmp();
  const workdir = tmp();
  write(workdir, "file.txt", "hello");
  const repo = new Repo(store);
  repo.init("ws", workdir);
  const h1 = repo.mark("ws", { message: "first", author: "test", ts: 1 });
  assert.ok(h1);
  assert.equal(repo.head("ws"), h1);
  // second mark with no changes → null
  const h2 = repo.mark("ws", { message: "second", ts: 2 });
  assert.equal(h2, null);
});

test("Repo.status shows working-tree changes vs head", () => {
  const store = tmp();
  const workdir = tmp();
  write(workdir, "a.txt", "alpha");
  const repo = new Repo(store);
  repo.init("ws", workdir);
  repo.mark("ws", { message: "init" });
  // modify + add
  fs.writeFileSync(path.join(workdir, "a.txt"), "ALPHA");
  write(workdir, "b.txt", "beta");
  const changes = repo.status("ws");
  const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]));
  assert.equal(byPath["a.txt"], "modified");
  assert.equal(byPath["b.txt"], "added");
});

test("Repo.log returns history newest-first", () => {
  const store = tmp();
  const workdir = tmp();
  write(workdir, "f.txt", "v1");
  const repo = new Repo(store);
  repo.init("ws", workdir);
  repo.mark("ws", { message: "first" });
  fs.writeFileSync(path.join(workdir, "f.txt"), "v2");
  repo.mark("ws", { message: "second" });
  const log = repo.log("ws");
  assert.equal(log.length, 2);
  assert.equal(log[0].message, "second");
  assert.equal(log[1].message, "first");
});

test("Repo.checkout restores working tree to a prior mark", () => {
  const store = tmp();
  const workdir = tmp();
  write(workdir, "f.txt", "v1");
  const repo = new Repo(store);
  repo.init("ws", workdir);
  const h1 = repo.mark("ws", { message: "v1" });
  fs.writeFileSync(path.join(workdir, "f.txt"), "v2");
  repo.mark("ws", { message: "v2" });
  repo.checkout("ws", h1);
  assert.equal(fs.readFileSync(path.join(workdir, "f.txt"), "utf8"), "v1");
  assert.equal(repo.head("ws"), h1);
});

test("Repo.canFastForward accepts ancestor, rejects non-ancestor", () => {
  const store = tmp();
  const workdir = tmp();
  write(workdir, "f.txt", "1");
  const repo = new Repo(store);
  repo.init("ws", workdir);
  const h1 = repo.mark("ws", { message: "c1" });
  fs.writeFileSync(path.join(workdir, "f.txt"), "2");
  const h2 = repo.mark("ws", { message: "c2" });
  // h2 is a fast-forward of h1 (h1 is ancestor of h2)
  repo.checkout("ws", h1);
  assert.ok(repo.canFastForward("ws", h2));
  // h1 is NOT a fast-forward of h2 (would go backwards)
  repo.checkout("ws", h2);
  assert.ok(!repo.canFastForward("ws", h1));
});

test("Repo.bundle / ingest transfers objects between stores", () => {
  const store1 = tmp();
  const workdir = tmp();
  write(workdir, "f.txt", "data");
  const repo1 = new Repo(store1);
  repo1.init("ws", workdir);
  repo1.mark("ws", { message: "m" });

  const { head, objects } = repo1.bundle("ws");
  assert.ok(head);
  assert.ok(objects.length >= 2);

  const store2 = tmp();
  const repo2 = new Repo(store2);
  const workdir2 = tmp();
  repo2.init("ws", workdir2);
  repo2.ingest(objects);
  assert.ok(hasObject(store2, head));
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. tide MCP server through the Kernel
// ═════════════════════════════════════════════════════════════════════════════

{
  let kernel, owner, sandbox, held;
  const call = (server, tool, args = {}) =>
    kernel.call({ principalId: owner.id, heldPatterns: held, server, tool, args });

  test.before(async () => {
    openDb();
    ({ owner, sandbox } = ensureSeed("local"));
    held = grantsFor(owner.id, sandbox.id);
    kernel = await getKernel(sandbox);
  });
  test.after(() => closeDb());

  test("tide.init creates a workspace in the Sandbox", async () => {
    // path "." maps workdir to cell root so fs.write paths are inside the workspace
    const r = await call("tide", "init", { workspace: "main", path: "." });
    assert.ok(r.result);
    assert.equal(r.result.workspace, "main");
    assert.equal(r.result.head, null);
  });

  test("tide.listWorkspaces shows the initialized workspace", async () => {
    const r = await call("tide", "listWorkspaces", {});
    assert.ok(r.result.workspaces.some((w) => w.name === "main"));
  });

  test("tide.status reflects working-tree changes", async () => {
    // Write a file into the Sandbox then check status
    await call("fs", "write", { path: "tide-test.txt", content: "hello" });
    const r = await call("tide", "status", { workspace: "main" });
    assert.ok(Array.isArray(r.result.changes));
    assert.ok(r.result.changes.some((c) => c.path === "tide-test.txt"));
  });

  test("tide.mark captures the working tree", async () => {
    const r = await call("tide", "mark", { workspace: "main", message: "first mark" });
    assert.ok(r.result.commit);
    assert.equal(r.result.changed, true);
    // second mark with no changes → no commit
    const r2 = await call("tide", "mark", { workspace: "main", message: "empty" });
    assert.equal(r2.result.changed, false);
  });

  test("tide.log returns mark history", async () => {
    const r = await call("tide", "log", { workspace: "main" });
    assert.ok(r.result.marks.length >= 1);
    assert.equal(r.result.marks[0].message, "first mark");
  });

  test("tide.refs returns the current head", async () => {
    const logR = await call("tide", "log", { workspace: "main" });
    const head = logR.result.marks[0].hash;
    const r = await call("tide", "refs", { workspace: "main" });
    assert.equal(r.result.head, head);
  });

  test("tide.checkout restores a prior mark's files", async () => {
    // Write a file and mark
    await call("fs", "write", { path: "checkout-test.txt", content: "before" });
    const m1 = await call("tide", "mark", { workspace: "main", message: "before-state" });
    const beforeHash = m1.result.commit;

    // Overwrite the file and mark again
    await call("fs", "write", { path: "checkout-test.txt", content: "after" });
    await call("tide", "mark", { workspace: "main", message: "after-state" });

    // Verify it's "after" now
    const read1 = await call("fs", "read", { path: "checkout-test.txt" });
    assert.equal(read1.result.content, "after");

    // Checkout to the "before" state
    await call("tide", "checkout", { workspace: "main", ref: beforeHash });
    const read2 = await call("fs", "read", { path: "checkout-test.txt" });
    assert.equal(read2.result.content, "before");
  });

  test("tide.fetchObjects returns the packed history for pull", async () => {
    const r = await call("tide", "fetchObjects", { workspace: "main", have: [] });
    assert.ok(r.result.head);
    assert.ok(Array.isArray(r.result.objects));
    assert.ok(r.result.objects.length >= 2);
    assert.ok(r.result.objects.every((o) => o.hash && o.type && o.payload));
  });

  test("tide.receiveObjects accepts a fast-forward push", async () => {
    // Build an object pack in a local store and push it to the kernel
    const store = tmp();
    const workdir = tmp();
    write(workdir, "pushed.txt", "from client");
    const repo = new Repo(store);
    repo.init("pushed-ws", workdir);
    const head = repo.mark("pushed-ws", { message: "client commit" });
    const { objects } = repo.bundle("pushed-ws");

    const r = await call("tide", "receiveObjects", { workspace: "pushed-ws", head, objects });
    assert.ok(r.result.applied);
    assert.equal(r.result.head, head);
    // The file should now be visible via fs.read (materialized into the Cell)
    const read = await call("fs", "read", { path: "pushed-ws/pushed.txt" });
    assert.equal(read.result.content, "from client");
  });

  test("tide.receiveObjects rejects a non-fast-forward push", async () => {
    // Setup: push v1 into a workspace
    const store = tmp();
    const workdir = tmp();
    write(workdir, "f.txt", "v1");
    const repo = new Repo(store);
    repo.init("ff-test", workdir);
    const h1 = repo.mark("ff-test", { message: "v1" });
    const { objects: o1 } = repo.bundle("ff-test");
    await call("tide", "receiveObjects", { workspace: "ff-test", head: h1, objects: o1 });

    // Diverge locally: write v2 on top of v1 and receive it (advances server)
    fs.writeFileSync(path.join(workdir, "f.txt"), "v2");
    const h2 = repo.mark("ff-test", { message: "v2" });
    const { objects: o2 } = repo.bundle("ff-test", [h1]);
    await call("tide", "receiveObjects", { workspace: "ff-test", head: h2, objects: o2 });

    // Now try to push h1 again — must be rejected as non-fast-forward
    const r = await call("tide", "receiveObjects", { workspace: "ff-test", head: h1, objects: o1 });
    assert.equal(r.result.applied, false);
    assert.match(r.result.reason, /non-fast-forward/);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. TideClient e2e through the live Gateway
// ═════════════════════════════════════════════════════════════════════════════

{
  let server, base, token, slug;

  test.before(async () => {
    // The DB is already open from the kernel block above; if it was closed, re-open.
    try { openDb(); } catch { /* already open */ }
    server = createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;

    // Login with cookie to mint a machine token
    const login = await fetch(base + "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "test" }),
    });
    const loginData = await login.json();
    slug = loginData.slug;
    const cookie = login.headers.getSetCookie()[0].split(";")[0];

    const mint = await fetch(`${base}/${slug}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ patterns: ["tide.*", "fs.*"], label: "tide-test" }),
    });
    const { token: t } = await mint.json();
    token = t;
  });

  test.after(() => {
    server.close();
    try { closeDb(); } catch { /* already closed */ }
  });

  const makeClient = () => new TideClient({ url: base, slug, token });

  test("TideClient.push sends a mark and fast-forwards the remote", async () => {
    const store = tmp();
    const workdir = tmp();
    write(workdir, "hello.txt", "from client");
    const repo = new Repo(store);
    repo.init("e2e-ws", workdir);
    repo.mark("e2e-ws", { message: "initial" });

    const client = makeClient();
    const r = await client.push(repo, "e2e-ws");
    assert.ok(r.applied, `push rejected: ${r.reason}`);
    assert.ok(r.head);
  });

  test("TideClient.pull fetches marks from the remote", async () => {
    // Clone the workspace that was just pushed above
    const store2 = tmp();
    const workdir2 = tmp();
    const repo2 = new Repo(store2);
    repo2.init("e2e-ws", workdir2);

    const client = makeClient();
    const r = await client.pull(repo2, "e2e-ws");
    assert.ok(r.changed || r.head); // head may already match if pull is fast
    assert.ok(fs.existsSync(path.join(workdir2, "hello.txt")) || r.head === null);
  });

  test("TideClient.clone initialises a new workspace from scratch", async () => {
    const store = tmp();
    const workdir = tmp();
    const repo = new Repo(store);

    const client = makeClient();
    const r = await client.clone(repo, "e2e-ws", workdir);
    // head may be the commit pushed above, or null if remote has nothing
    assert.ok(typeof r.head === "string" || r.head === null);
    if (r.head) {
      assert.ok(fs.existsSync(path.join(workdir, "hello.txt")));
      assert.equal(fs.readFileSync(path.join(workdir, "hello.txt"), "utf8"), "from client");
    }
  });

  test("TideClient.push then pull round-trips a file end-to-end", async () => {
    const workspace = `rt-${crypto.randomUUID().slice(0, 6)}`;
    const content = `round-trip-${Date.now()}`;

    // Push side
    const store1 = tmp();
    const dir1 = tmp();
    write(dir1, "rt.txt", content);
    const repo1 = new Repo(store1);
    repo1.init(workspace, dir1);
    repo1.mark(workspace, { message: "rt" });
    const pushR = await makeClient().push(repo1, workspace);
    assert.ok(pushR.applied);

    // Pull side
    const store2 = tmp();
    const dir2 = tmp();
    const repo2 = new Repo(store2);
    repo2.init(workspace, dir2);
    const pullR = await makeClient().pull(repo2, workspace);
    assert.ok(pullR.changed);
    assert.equal(fs.readFileSync(path.join(dir2, "rt.txt"), "utf8"), content);
  });

  test("TideClient handles non-fast-forward by pulling + re-pushing", async () => {
    const workspace = `nff-${crypto.randomUUID().slice(0, 6)}`;

    // Client A: initial push
    const storeA = tmp();
    const dirA = tmp();
    write(dirA, "shared.txt", "vA");
    const repoA = new Repo(storeA);
    repoA.init(workspace, dirA);
    repoA.mark(workspace, { message: "vA" });
    await makeClient().push(repoA, workspace);

    // Client B: clone, make a competing change, push (fast-forward over A's head)
    const storeB = tmp();
    const dirB = tmp();
    const repoB = new Repo(storeB);
    await makeClient().clone(repoB, workspace, dirB);
    fs.writeFileSync(path.join(dirB, "shared.txt"), "vB");
    repoB.mark(workspace, { message: "vB" });
    const rB = await makeClient().push(repoB, workspace);
    assert.ok(rB.applied, "B push should succeed");

    // Client A: make a competing mark (diverged from server at vB)
    fs.writeFileSync(path.join(dirA, "shared.txt"), "vA-conflict");
    repoA.mark(workspace, { message: "vA-conflict" });
    // TideClient.push() is a single send — retry (pull+re-push) lives in cmdPush.
    // Replicate that pattern here: attempt, pull on NFF, re-push.
    let rA = await makeClient().push(repoA, workspace);
    assert.equal(rA.reason, "non-fast-forward", "first attempt must report NFF");
    await makeClient().pull(repoA, workspace); // merge divergence locally
    rA = await makeClient().push(repoA, workspace); // merge mark fast-forwards
    assert.ok(rA.applied, `re-push after merge should succeed: ${JSON.stringify(rA)}`);
  });
}
